# RFC-0002: RestQL v2 Core — One IR, Three Producers

**Status:** Accepted for implementation
**Author:** Mohammad Sidani
**Scope:** Single-session executable (Phase 0–3 tonight; Phase 4+ deferred)
**Method:** TDD, characterization-first, zero regressions on v1

---

## 1. One-line architecture

> RestQL v2 has no query language to learn. The query language is a compiler target.

One source of truth — the **IR** (a declarative, serializable execution graph).
Three producers — **typed builder** (humans), **AI codegen** (LLMs), **OpenAPI import** (tooling).
One consumer — the **executor** (parallelism + deduplication).

```
Typed Builder ──┐
AI Codegen ─────┼──▶  IR (JSON graph)  ──▶  Planner  ──▶  Executor  ──▶  Typed Result
OpenAPI Import ─┘        (validated)         (waves)      (dedup)
```

## 2. Goals / Non-goals

**Goals (v2.0 core)**

1. IR schema: versioned, validated, serializable execution graph.
2. Planner: topological wave computation (what runs in parallel, what waits).
3. Executor: runs waves via injected transport; dedupes identical requests; partial-success result model.
4. Typed builder: constructs IR; zero runtime magic — it only builds the data structure.
5. v1 behavior locked by characterization tests; v1 public API unchanged.

**Non-goals (explicitly deferred — do not implement, do not scaffold)**

Retry/backoff, circuit breakers, request coalescing (`?ids=1,2,3`), caching, plugin system, edge/WASM targets, OpenTelemetry, CLI (`graph`/`benchmark`), OpenAPI generator, AI codegen layer. Each gets its own RFC. A `// v2.1` comment is the only permitted trace of them.

## 3. v1 reality (verified against master, not assumed)

- Pipeline: `Tokenizer → Parser → SDLParser → SchemaValidator (465L) → RestQL (712L) → BatchManager / CacheManager → RestQLExecutor`. ~2,800 lines core.
- Test coverage: **one** test file (`test/batch/BatchManager/index.test.ts`). Everything else is untested.
- `fetch` is called directly inside `RestQLExecutor.performApiRequest` (line ~189) — no injection seam. Characterization tests must stub global `fetch` via `vi.stubGlobal`.
- **Defect A (perf):** nested resources resolve via `await executeQueryField` inside a sequential `for...of` in `shapeData` (~line 383). Deep queries = serial round-trips. v2 waves fix this.
- **Defect B (perf):** no in-flight request deduplication; `CacheManager` is TTL-only. v2 dedup fixes this.
- Style: class inheritance from `Logger`, 61 `any` in `RestQL.ts` alone, `lodash.get`. v1 is frozen as-is; v2 invariants (§9) apply to `src/v2/` only.

Defects A and B are the benchmark narrative: same query, v1 sequential vs v2 waves + dedup.

## 3b. Zero-regression strategy

v1 is **not modified tonight**. Order of operations is non-negotiable:

1. **Phase 0 — Characterization tests first**, through the **public surface only**: `new RestQL(sdl, baseUrls, opts).execute(operationString, variables)` with stubbed `fetch`. Do not test private modules individually — v1 has no seams and we are not adding any. If a quirk is found, assert the quirk with `// CHARACTERIZATION: documents existing behavior, do not "fix"`.
2. v2 lives in `src/v2/` alongside v1. No shared mutable modules. v1 entry point untouched.
3. CI gate: v1 suite green + v2 suite green, or nothing merges.

## 4. Package layout

```
src/
  index.ts            # v1 public API — DO NOT TOUCH
  v2/
    ir/
      schema.ts       # IR types (discriminated unions) + IR_VERSION
      validate.ts     # parse/validate unknown → IR (Result type, no throws)
    plan/
      planner.ts      # IR → ExecutionPlan (waves via topo sort, cycle detection)
    exec/
      executor.ts     # ExecutionPlan → NodeResult map (dedup, partial success)
      transport.ts    # Transport interface (the seam) + fetch adapter
    builder/
      builder.ts      # typed builder → IR
    index.ts          # v2 public API
tests/
  v1/characterization.spec.ts
  v2/ir.spec.ts  plan.spec.ts  exec.spec.ts  builder.spec.ts
```

## 5. IR schema (the contract everything serves)

```ts
export const IR_VERSION = '2.0' as const;

export interface QueryIR {
  version: typeof IR_VERSION;
  nodes: Record<NodeId, NodeIR>;   // flat map, edges by reference — not nested trees
}

export type NodeIR = HttpNodeIR;   // discriminated union; future: GrpcNodeIR, etc.

export interface HttpNodeIR {
  kind: 'http';
  id: NodeId;
  request: {
    method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
    url: string;                    // may contain {bindings}
  };
  dependsOn: NodeId[];              // explicit edges — the planner's only input
  bindings?: Record<string, Binding>; // { orderId: { from: 'user', path: 'orders[0].id' } }
  select?: string[];                // projection, optional
}

export type NodeId = string & { readonly __brand: 'NodeId' };

export interface Binding { from: NodeId; path: string }
```

Design invariants:

- ✓ Flat node map + `dependsOn` edges ✗ nested tree (trees can't express diamonds: A→B, A→C, B+C→D)
- ✓ `validate(unknown): Result<QueryIR, IRError[]>` ✗ throwing validators
- ✓ Branded `NodeId` ✗ bare strings crossing module boundaries
- ✓ IR is pure data, JSON-serializable, no functions ✗ closures/callbacks inside IR

## 6. Planner

```ts
// planner.ts — pure function, no I/O
export function plan(ir: QueryIR): Result<ExecutionPlan, PlanError>;

export interface ExecutionPlan {
  waves: NodeId[][];   // waves[0] = no deps, waves[1] = deps satisfied by wave 0, ...
}
```

- Kahn's algorithm. Cycle → `PlanError { kind: 'cycle', nodes: [...] }`, never a hang.
- Deterministic wave ordering (sort node ids within a wave) — tests depend on it.

## 7. Executor

```ts
export interface Transport {
  execute(req: ResolvedRequest, signal: AbortSignal): Promise<TransportResult>;
}

export async function execute(
  plan: ExecutionPlan,
  ir: QueryIR,
  transport: Transport,
): Promise<QueryResult>;

export type NodeResult =
  | { status: 'ok'; data: unknown }
  | { status: 'error'; error: NodeError }
  | { status: 'skipped'; reason: { dependencyFailed: NodeId } };

export interface QueryResult {
  nodes: Record<NodeId, NodeResult>;
  meta: { dedupedRequests: number; waves: number };
}
```

- **Dedup:** key = `method + resolvedUrl`; identical in-flight requests share one promise; `meta.dedupedRequests` counts savings (this number is the future benchmark demo).
- **Partial success:** a failed node marks dependents `skipped`, siblings unaffected. `execute` never throws for node failures — only for programmer errors (invalid plan).
- **Bindings:** resolved from dependency results via `path`; unresolvable binding = node error, not a throw.
- Transport is the *only* seam touching the network. Tests use `FakeTransport` with scripted latencies/failures — no HTTP mocking libraries.

## 8. Builder

```ts
const q = query()
  .node('user',   http.get('/users/{id}', { id: 1 }))
  .node('orders', http.get('/users/{userId}/orders')
                      .bind('userId', from('user', 'id')))
  .node('cart',   http.get('/users/{userId}/cart')
                      .bind('userId', from('user', 'id')))
  .build();          // → QueryIR (validated)
```

- Builder produces IR and nothing else. It contains **zero execution logic**.
- `.build()` runs `validate()` — a builder can never emit an invalid IR.
- Fluent, immutable steps (each call returns a new builder value).

## 9. Style invariants (enforce throughout; violations are review blockers)

- ✓ `type`/`interface` + pure functions + factories ✗ classes with inheritance
- ✓ discriminated unions + exhaustive `switch` with `never` check ✗ boolean flags / enums-as-strings comparisons
- ✓ `Result<T, E>` for expected failures ✗ throw-for-control-flow
- ✓ dependency injection through interfaces (`Transport`) ✗ importing `fetch` inside core modules
- ✓ `unknown` at boundaries, narrowed by validators ✗ `any`, `as` casts (except the two branded-type constructors)
- ✓ every module ≤ ~150 lines, one responsibility ✗ utils.ts grab-bags
- tsconfig: `strict`, `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `verbatimModuleSyntax`
- Vitest; test names read as specs: `it('dedupes identical in-flight GET requests into one transport call')`

## 10. Session plan (execute in order; each phase gates the next)

**Phase 0 — Lock v1 (do first, no exceptions)**
Write `tests/v1/characterization.spec.ts` — end-to-end through `RestQL.execute()` with `vi.stubGlobal('fetch', ...)`. Pin 8–12 behaviors: (1) simple query happy path + shaped output, (2) nested resource resolution incl. its *sequential* fetch order (assert call order — this quirk is the v2 benchmark baseline), (3) mutation `create/update/patch/delete` → HTTP method mapping, (4) cache hit skips fetch / miss fetches, (5) missing required variable → `ValidationError`, (6) unknown resource → throw, (7) `dataPath` extraction, (8) cherry-pick field projection. Keep the existing BatchManager suite untouched. Gate: suite green against unmodified v1.

**Phase 1 — IR (red → green)**
Write `ir.spec.ts` first: valid IR accepted; missing node ref rejected; unknown version rejected; duplicate id rejected; round-trips through `JSON.parse(JSON.stringify(...))`. Then implement `schema.ts` + `validate.ts`.

**Phase 2 — Planner**
`plan.spec.ts` first: independent nodes → one wave; chain → n waves; diamond A→(B,C)→D → 3 waves; cycle → `PlanError`; deterministic ordering. Then `planner.ts`.

**Phase 3 — Executor**
`exec.spec.ts` first with `FakeTransport`: waves execute in order; nodes within a wave run concurrently (assert via FakeTransport call-timing log); identical requests deduped with correct `meta.dedupedRequests`; failed node → dependents `skipped`, siblings `ok`; binding resolution; abort signal propagation. Then `executor.ts` + `transport.ts`.

**Phase 4 — Builder (if time remains; otherwise tomorrow)**
`builder.spec.ts` first: builder output === handwritten IR fixture (deep equal); `.build()` rejects dangling `from()` refs. Then `builder.ts`.

**Definition of done (tonight):** v1 characterization suite green · Phases 1–3 green · `src/v2/index.ts` exports `validate`, `plan`, `execute`, IR types · no non-goal code exists in the tree.

## 11. What this buys next (not tonight)

The `meta` object is the future `restql benchmark` output. The `Transport` seam is where retry/breakers land as decorators. The IR is what the OpenAPI generator emits and what an LLM targets — the AI-native wedge needs zero changes to core, which is the entire point of the IR-first design.
