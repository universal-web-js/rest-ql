/**
 * RFC-0002 — Deep benchmarks: v1 engine vs v2 engine over REAL node fetch.
 *
 * Methodology
 *  - A local node:http server simulates an API with fixed per-request latency
 *    (deterministic, no jitter) and records ground truth: request count,
 *    max in-flight concurrency, and a per-request timeline.
 *  - v1 runs the ACTUAL RestQL v1 engine (SDL + query strings, nested resources).
 *  - v2 runs the ACTUAL v2 pipeline (builder → validate → plan → execute → fetchTransport).
 *  - Each scenario: warmup runs discarded, then N measured iterations.
 *    Fresh v1 client per iteration + useCache:false (isolates engine, not TTL cache).
 *  - Reported: min / p50 / p95 / max / mean wall time, server-observed
 *    concurrency, request counts, dedup savings, critical-path analysis
 *    (theoretical floor = waves × latency) and engine overhead above it.
 *
 * Run: npx tsx bench/benchmark.mjs
 */
import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import { RestQL } from '../src/core/RestQL'
import { query, http, from, plan, execute, fetchTransport } from '../src/v2/index.ts'

// ---------------------------------------------------------------- config
const LATENCY_MS = 25
const ITERATIONS = 15
const WARMUP = 3

// ---------------------------------------------------------------- server
function makeServer (latencyMs) {
  let active = 0
  const stats = { requests: 0, maxConcurrent: 0, timeline: [] }
  let epoch = performance.now()

  const server = createServer((req, res) => {
    active += 1
    stats.requests += 1
    stats.maxConcurrent = Math.max(stats.maxConcurrent, active)
    const startedAt = performance.now() - epoch
    const url = new URL(req.url, 'http://localhost')

    const respond = (payload) => {
      setTimeout(() => {
        active -= 1
        stats.timeline.push({
          path: url.pathname,
          start: Math.round(startedAt),
          end: Math.round(performance.now() - epoch)
        })
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify(payload))
      }, latencyMs)
    }

    const routes = {
      '/users/1': { data: { user_id: 'u-1', full_name: 'Sippi' }, id: 'u-1', name: 'Sippi' },
      '/orders': { data: { total_amount: 120, order_id: 'o-9' }, items: [{ id: 'o-9', total: 120 }] },
      '/cart': { data: { item_count: 3 }, items: 3 },
      '/notifications': { data: { unread_count: 2 }, unread: 2 },
      '/recommendations': { data: { top_pick: 'club-x' }, top: 'club-x' },
      '/payments': { data: { payment_status: 'paid' }, status: 'paid' },
      '/inventory': { data: { stock_level: 9 }, stock: 9 },
      '/wishlist': { data: { wish_count: 4 }, wishes: 4 }
    }
    respond(routes[url.pathname] ?? { data: {} })
  })

  return {
    server,
    stats,
    reset () {
      stats.requests = 0
      stats.maxConcurrent = 0
      stats.timeline = []
      epoch = performance.now()
    },
    listen: () => new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port))),
    close: () => new Promise((resolve) => server.close(resolve))
  }
}

// ---------------------------------------------------------------- helpers
function percentile (sorted, p) {
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

function summarize (samples) {
  const sorted = [...samples].sort((a, b) => a - b)
  const mean = samples.reduce((s, v) => s + v, 0) / samples.length
  return {
    min: sorted[0],
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    max: sorted[sorted.length - 1],
    mean
  }
}

function fmt (ms) { return `${ms.toFixed(1)}ms` }

async function measure (name, iterations, warmup, runOnce, serverHandle) {
  for (let i = 0; i < warmup; i += 1) await runOnce()
  const samples = []
  let lastMeta = null
  serverHandle.reset()
  const requestsBefore = 0
  for (let i = 0; i < iterations; i += 1) {
    const t0 = performance.now()
    lastMeta = await runOnce()
    samples.push(performance.now() - t0)
  }
  const stats = summarize(samples)
  const requestsPerIteration = (serverHandle.stats.requests - requestsBefore) / iterations
  return { name, stats, requestsPerIteration, maxConcurrent: serverHandle.stats.maxConcurrent, meta: lastMeta }
}

function printResult (r, extras = '') {
  console.log(
    `  ${r.name.padEnd(34)} p50 ${fmt(r.stats.p50).padStart(8)}  p95 ${fmt(r.stats.p95).padStart(8)}  ` +
    `mean ${fmt(r.stats.mean).padStart(8)}  req/iter ${String(r.requestsPerIteration).padStart(4)}  ` +
    `max-concurrency ${String(r.maxConcurrent).padStart(2)}${extras}`
  )
}

// ---------------------------------------------------------------- v1 setup
// SDL modeling the profile page. Each nested field is a RESOURCE (own endpoint)
// so v1 resolves it with its serial per-field fetch inside shapeData.
function v1Sdl (breadthFields) {
  const userFields = breadthFields
    .map((f) => `    ${f.name}: ${f.type} @from("${f.name}_ref")`)
    .join('\n')
  const resourceTypes = breadthFields
    .map((f) => `
  type ${f.type} {
    value: String @from("${f.valueFrom}")
    ${f.nested ? `${f.nested.name}: ${f.nested.type} @from("${f.nested.name}_ref")` : ''}
    @endpoint(GET, "${f.path}", "data")
  }`)
    .join('\n')
  const nestedTypes = breadthFields
    .filter((f) => f.nested)
    .map((f) => `
  type ${f.nested.type} {
    value: String @from("${f.nested.valueFrom}")
    @endpoint(GET, "${f.nested.path}", "data")
  }`)
    .join('\n')

  return `
  type User {
    id: String @from("user_id")
    name: String @from("full_name")
${userFields}
    @endpoint(GET, "/users/{userId}", "data")
  }
${resourceTypes}
${nestedTypes}
`
}

function v1Query (breadthFields) {
  const parts = breadthFields
    .map((f) => `${f.name} { value ${f.nested ? `${f.nested.name} { value }` : ''} }`)
    .join('\n      ')
  return `query Profile($userId: String!) {
    user(userId: $userId) {
      name
      ${parts}
    }
  }`
}

// ---------------------------------------------------------------- scenarios
const PROFILE_FIELDS = [
  { name: 'orders', type: 'Order', path: '/orders', valueFrom: 'total_amount', nested: { name: 'payments', type: 'Payment', path: '/payments', valueFrom: 'payment_status' } },
  { name: 'cart', type: 'Cart', path: '/cart', valueFrom: 'item_count' },
  { name: 'notifications', type: 'Notification', path: '/notifications', valueFrom: 'unread_count' }
]

function v2ProfileIR (base) {
  const built = query()
    .node('user', http.get(`${base}/users/{id}`, { id: 1 }))
    .node('orders', http.get(`${base}/orders`).bind('userId', from('user', 'id')))
    .node('cart', http.get(`${base}/cart`).bind('userId', from('user', 'id')))
    .node('notifications', http.get(`${base}/notifications`).bind('userId', from('user', 'id')))
    .node('payments', http.get(`${base}/payments`).bind('orderId', from('orders', 'items[0].id')))
    .build()
  if (!built.ok) throw new Error(JSON.stringify(built.error))
  const planned = plan(built.value)
  if (!planned.ok) throw new Error(JSON.stringify(planned.error))
  return { ir: built.value, plan: planned.value }
}

async function main () {
  const handle = makeServer(LATENCY_MS)
  const port = await handle.listen()
  const base = `http://127.0.0.1:${port}`
  const transport = fetchTransport()

  console.log(`\nRestQL v1 vs v2 — real node fetch over 127.0.0.1:${port}`)
  console.log(`latency/request: ${LATENCY_MS}ms · iterations: ${ITERATIONS} (+${WARMUP} warmup) · node ${process.version}\n`)

  // ---------- Scenario 1: profile page (5 logical resources, depth 3)
  console.log('S1 · Profile page — user → (orders, cart, notifications), orders → payments')
  const sdl = v1Sdl(PROFILE_FIELDS)
  const op = v1Query(PROFILE_FIELDS)

  const v1Profile = await measure('v1 engine (serial nested)', ITERATIONS, WARMUP, async () => {
    const client = new RestQL(sdl, { default: base }, { batchInterval: 0 })
    await client.execute(op, { userId: '1' }, { useCache: false })
  }, handle)
  printResult(v1Profile)

  const { ir, plan: executionPlan } = v2ProfileIR(base)
  const v2Profile = await measure('v2 engine (waves)', ITERATIONS, WARMUP, async () => {
    const result = await execute(executionPlan, ir, transport)
    return result.meta
  }, handle)
  printResult(v2Profile)

  const criticalPath = executionPlan.waves.length * LATENCY_MS
  console.log(`  critical path (waves × latency):   ${criticalPath}ms floor · ` +
    `v2 engine overhead above floor: ${fmt(v2Profile.stats.p50 - criticalPath)} · ` +
    `v1 overhead above its serial floor (${5 * LATENCY_MS}ms): ${fmt(v1Profile.stats.p50 - 5 * LATENCY_MS)}`)
  console.log(`  speedup p50: ${(v1Profile.stats.p50 / v2Profile.stats.p50).toFixed(2)}×\n`)

  // ---------- Scenario 1b: hand-written native fetch (the code v2 claims to generate)
  console.log('S1b · Hand-written native fetch — optimal Promise.all orchestration, same graph')
  const nativeOptimal = await measure('native fetch (hand-optimized)', ITERATIONS, WARMUP, async () => {
    // A senior engineer's best manual version: waves coded by hand.
    // (First attempt at this baseline accidentally serialized the fetches by
    // awaiting inside the array literal — the exact bug class v2 compiles away.)
    const user = await (await fetch(`${base}/users/1`)).json()
    void user
    const [orders] = await Promise.all([
      fetch(`${base}/orders`).then((r) => r.json()),
      fetch(`${base}/cart`).then((r) => r.json()),
      fetch(`${base}/notifications`).then((r) => r.json())
    ])
    void orders
    await (await fetch(`${base}/payments`)).json()
    return null
  }, handle)
  printResult(nativeOptimal)

  const nativeNaive = await measure('native fetch (naive sequential)', ITERATIONS, WARMUP, async () => {
    await (await fetch(`${base}/users/1`)).json()
    await (await fetch(`${base}/orders`)).json()
    await (await fetch(`${base}/cart`)).json()
    await (await fetch(`${base}/notifications`)).json()
    await (await fetch(`${base}/payments`)).json()
    return null
  }, handle)
  printResult(nativeNaive)
  console.log(`  v2 vs hand-optimized native: +${fmt(v2Profile.stats.p50 - nativeOptimal.stats.p50)} p50 — the price of writing zero orchestration\n`)

  // ---------- Scenario 2: breadth scaling — K independent siblings under user
  console.log('S2 · Breadth scaling — K independent resources under user (v1 grows O(K), v2 stays O(2 waves))')
  const catalog = [
    { name: 'orders', type: 'Order', path: '/orders', valueFrom: 'total_amount' },
    { name: 'cart', type: 'Cart', path: '/cart', valueFrom: 'item_count' },
    { name: 'notifications', type: 'Notification', path: '/notifications', valueFrom: 'unread_count' },
    { name: 'recommendations', type: 'Recommendation', path: '/recommendations', valueFrom: 'top_pick' },
    { name: 'inventory', type: 'Inventory', path: '/inventory', valueFrom: 'stock_level' },
    { name: 'wishlist', type: 'Wishlist', path: '/wishlist', valueFrom: 'wish_count' }
  ]
  for (const k of [2, 4, 6]) {
    const fields = catalog.slice(0, k)
    const kSdl = v1Sdl(fields)
    const kOp = v1Query(fields)
    const v1K = await measure(`v1 · K=${k}`, ITERATIONS, WARMUP, async () => {
      const client = new RestQL(kSdl, { default: base }, { batchInterval: 0 })
      await client.execute(kOp, { userId: '1' }, { useCache: false })
    }, handle)

    let builder = query().node('user', http.get(`${base}/users/{id}`, { id: 1 }))
    for (const f of fields) {
      builder = builder.node(f.name, http.get(`${base}${f.path}`).bind('u', from('user', 'id')))
    }
    const kBuilt = builder.build()
    if (!kBuilt.ok) throw new Error('build failed')
    const kPlan = plan(kBuilt.value)
    if (!kPlan.ok) throw new Error('plan failed')
    const v2K = await measure(`v2 · K=${k}`, ITERATIONS, WARMUP,
      async () => (await execute(kPlan.value, kBuilt.value, transport)).meta, handle)

    printResult(v1K)
    printResult(v2K, `  speedup ${(v1K.stats.p50 / v2K.stats.p50).toFixed(2)}×`)
  }
  console.log()

  // ---------- Scenario 3: dedup — 6 nodes, one shared upstream URL
  console.log('S3 · Deduplication — 6 nodes all requiring GET /users/1')
  let dedupBuilder = query()
  for (let i = 0; i < 6; i += 1) {
    dedupBuilder = dedupBuilder.node(`n${i}`, http.get(`${base}/users/{id}`, { id: 1 }))
  }
  const dedupBuilt = dedupBuilder.build()
  if (!dedupBuilt.ok) throw new Error('build failed')
  const dedupPlan = plan(dedupBuilt.value)
  if (!dedupPlan.ok) throw new Error('plan failed')
  const v2Dedup = await measure('v2 · 6 nodes → shared URL', ITERATIONS, WARMUP,
    async () => (await execute(dedupPlan.value, dedupBuilt.value, transport)).meta, handle)
  printResult(v2Dedup, `  deduped/iter ${v2Dedup.meta.dedupedRequests}`)
  console.log(`  network requests saved: ${((v2Dedup.meta.dedupedRequests / 6) * 100).toFixed(0)}%  (v1 baseline: 0% — no in-flight dedup)\n`)

  // ---------- Scenario 4: engine overhead at zero network latency
  console.log('S4 · Pure engine overhead — same profile graph, 0ms server latency')
  await handle.close()
  const fastHandle = makeServer(0)
  const fastPort = await fastHandle.listen()
  const fastBase = `http://127.0.0.1:${fastPort}`

  const fastFields = PROFILE_FIELDS
  const fastSdl = v1Sdl(fastFields)
  const fastOp = v1Query(fastFields)
  const v1Fast = await measure('v1 engine floor', ITERATIONS * 2, WARMUP, async () => {
    const client = new RestQL(fastSdl, { default: fastBase }, { batchInterval: 0 })
    await client.execute(fastOp, { userId: '1' }, { useCache: false })
  }, fastHandle)

  const fast = v2ProfileIR(fastBase)
  const v2Fast = await measure('v2 engine floor', ITERATIONS * 2, WARMUP,
    async () => (await execute(fast.plan, fast.ir, transport)).meta, fastHandle)

  printResult(v1Fast)
  printResult(v2Fast)
  console.log(`  note: v1 floor includes SDL+query parsing per iteration (its public usage pattern);`)
  console.log(`        v2 floor is plan-once/execute-many by design — parsing cost is zero at request time.\n`)

  // ---------- Scenario 5: concurrency truth from the server's perspective
  console.log('S5 · Server-observed request timeline (single run, profile page)')
  const timelineHandle = makeServer(LATENCY_MS)
  const tlPort = await timelineHandle.listen()
  const tlBase = `http://127.0.0.1:${tlPort}`

  timelineHandle.reset()
  const tlClient = new RestQL(v1Sdl(PROFILE_FIELDS), { default: tlBase }, { batchInterval: 0 })
  await tlClient.execute(v1Query(PROFILE_FIELDS), { userId: '1' }, { useCache: false })
  console.log('  v1:')
  for (const t of timelineHandle.stats.timeline) {
    const bar = ' '.repeat(Math.round(t.start / 5)) + '█'.repeat(Math.max(1, Math.round((t.end - t.start) / 5)))
    console.log(`    ${t.path.padEnd(18)} ${String(t.start).padStart(4)}→${String(t.end).padEnd(4)} ${bar}`)
  }

  timelineHandle.reset()
  const tl = v2ProfileIR(tlBase)
  await execute(tl.plan, tl.ir, transport)
  console.log('  v2:')
  for (const t of timelineHandle.stats.timeline) {
    const bar = ' '.repeat(Math.round(t.start / 5)) + '█'.repeat(Math.max(1, Math.round((t.end - t.start) / 5)))
    console.log(`    ${t.path.padEnd(18)} ${String(t.start).padStart(4)}→${String(t.end).padEnd(4)} ${bar}`)
  }

  await timelineHandle.close()
  await fastHandle.close()
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
