import type { NodeId, NodeIR, QueryIR } from '../ir/schema'
import type { ExecutionPlan } from '../plan/planner'
import type { ResolvedRequest, Transport, TransportResult } from './transport'

export interface NodeError {
  readonly message: string
  readonly status?: number
}

export type NodeResult =
  | { status: 'ok'; data: unknown }
  | { status: 'error'; error: NodeError }
  | { status: 'skipped'; reason: { dependencyFailed: NodeId } }

export interface QueryResult {
  readonly nodes: Readonly<Record<NodeId, NodeResult>>
  readonly meta: {
    readonly dedupedRequests: number
    readonly waves: number
  }
}

export interface ExecuteOptions {
  readonly signal?: AbortSignal
}

/** Resolve `a.b[0].c` against unknown data. Pure; returns undefined on any miss. */
function getPath (data: unknown, path: string): unknown {
  const segments = path
    .replace(/\[(\d+)\]/g, '.$1')
    .split('.')
    .filter((segment) => segment.length > 0)

  let current: unknown = data
  for (const segment of segments) {
    if (current === null || typeof current !== 'object') return undefined
    current = (current as Record<string, unknown>)[segment]
  }
  return current
}

type ResolveOutcome =
  | { ok: true; request: ResolvedRequest }
  | { ok: false; failure: NodeResult }

function resolveRequest (
  node: NodeIR,
  results: Record<NodeId, NodeResult>
): ResolveOutcome {
  for (const dep of node.dependsOn) {
    const depResult = results[dep]
    if (depResult === undefined || depResult.status !== 'ok') {
      return { ok: false, failure: { status: 'skipped', reason: { dependencyFailed: dep } } }
    }
  }

  let url = node.request.url
  for (const [name, binding] of Object.entries(node.bindings ?? {})) {
    const source = results[binding.from]
    if (source === undefined || source.status !== 'ok') {
      return { ok: false, failure: { status: 'skipped', reason: { dependencyFailed: binding.from } } }
    }
    const value = getPath(source.data, binding.path)
    if (value === undefined) {
      return {
        ok: false,
        failure: {
          status: 'error',
          error: { message: `Binding "${name}" unresolvable: path "${binding.path}" on node "${binding.from}"` }
        }
      }
    }
    url = url.replaceAll(`{${name}}`, encodeURIComponent(String(value)))
  }

  return { ok: true, request: { method: node.request.method, url } }
}

function toNodeResult (transportResult: TransportResult): NodeResult {
  return transportResult.ok
    ? { status: 'ok', data: transportResult.data }
    : { status: 'error', error: transportResult.error }
}

/**
 * RFC-0002 §7. Never throws for node failures — errors are first-class results.
 * Dedup key: method + resolved URL; identical in-flight requests share one promise.
 */
export async function execute (
  plan: ExecutionPlan,
  ir: QueryIR,
  transport: Transport,
  options: ExecuteOptions = {}
): Promise<QueryResult> {
  const signal = options.signal ?? new AbortController().signal
  const results: Record<NodeId, NodeResult> = {}
  const inFlight = new Map<string, Promise<TransportResult>>()
  let dedupedRequests = 0

  for (const wave of plan.waves) {
    await Promise.all(
      wave.map(async (id) => {
        const node = ir.nodes[id]
        if (node === undefined) {
          results[id] = { status: 'error', error: { message: `Plan references unknown node "${id}"` } }
          return
        }

        const resolved = resolveRequest(node, results)
        if (!resolved.ok) {
          results[id] = resolved.failure
          return
        }

        const dedupKey = `${resolved.request.method} ${resolved.request.url}`
        const existing = inFlight.get(dedupKey)
        if (existing !== undefined) {
          dedupedRequests += 1
          results[id] = toNodeResult(await existing)
          return
        }

        const pending = transport.execute(resolved.request, signal)
        inFlight.set(dedupKey, pending)
        results[id] = toNodeResult(await pending)
      })
    )
  }

  return { nodes: results, meta: { dedupedRequests, waves: plan.waves.length } }
}
