/**
 * perf/v1-engine — patched v1 vs pristine master v1 vs native fetch, real node:http.
 * Setup: git worktree add /tmp/restql-master master && ln -s $PWD/node_modules /tmp/restql-master/node_modules
 * Run:   npx tsx bench/v1-bench.mjs
 */
import { createServer } from 'node:http'
import { performance } from 'node:perf_hooks'
import { RestQL as PatchedRestQL } from '../src/core/RestQL'
import { RestQL as MasterRestQL } from '/tmp/restql-master/src/core/RestQL'

const LATENCY = 25, ITER = 15, WARMUP = 3

function makeServer () {
  let active = 0
  const stats = { requests: 0, maxConcurrent: 0 }
  const server = createServer((req, res) => {
    active += 1; stats.requests += 1
    stats.maxConcurrent = Math.max(stats.maxConcurrent, active)
    const path = new URL(req.url, 'http://x').pathname
    const routes = {
      '/users/1': { data: { user_id: 'u-1', full_name: 'S', orders_ref: {}, cart_ref: {}, notifications_ref: {}, recommendations_ref: {}, inventory_ref: {}, wishlist_ref: {} } },
      '/orders': { data: { total_amount: 120, payments_ref: {} } },
      '/payments': { data: { payment_status: 'paid' } },
      '/cart': { data: { item_count: 3 } },
      '/notifications': { data: { unread_count: 2 } },
      '/recommendations': { data: { top_pick: 'x' } },
      '/inventory': { data: { stock_level: 9 } },
      '/wishlist': { data: { wish_count: 4 } }
    }
    setTimeout(() => { active -= 1; res.writeHead(200, {'Content-Type':'application/json'}); res.end(JSON.stringify(routes[path] ?? { data: {} })) }, LATENCY)
  })
  return { server, stats, reset(){ stats.requests=0; stats.maxConcurrent=0 }, listen: () => new Promise(r => server.listen(0,'127.0.0.1',()=>r(server.address().port))), close: () => new Promise(r => server.close(r)) }
}

const FIELDS = [
  ['orders','Order','/orders','total_amount', ['payments','Payment','/payments','payment_status']],
  ['cart','Cart','/cart','item_count', null],
  ['notifications','Notification','/notifications','unread_count', null],
  ['recommendations','Recommendation','/recommendations','top_pick', null],
  ['inventory','Inventory','/inventory','stock_level', null],
  ['wishlist','Wishlist','/wishlist','wish_count', null]
]

function sdlFor (k, withNested = true) {
  const fields = FIELDS.slice(0, k)
  const userLines = fields.map(([n,t]) => `    ${n}: ${t} @from("${n}_ref")`).join('\n')
  const types = fields.map(([n,t,p,v,nested]) => {
    const nestedField = (withNested && nested) ? `${nested[0]}: ${nested[1]} @from("${nested[0]}_ref")` : ''
    const nestedType = (withNested && nested) ? `
  type ${nested[1]} {
    value: String @from("${nested[3]}")
    @endpoint(GET, "${nested[2]}", "data")
  }` : ''
    return `
  type ${t} {
    value: String @from("${v}")
    ${nestedField}
    @endpoint(GET, "${p}", "data")
  }${nestedType}`
  }).join('\n')
  return `
  type User {
    name: String @from("full_name")
${userLines}
    @endpoint(GET, "/users/{userId}", "data")
  }
${types}`
}

function opFor (k, withNested = true) {
  const parts = FIELDS.slice(0, k).map(([n,,,,nested]) => `${n} { value ${(withNested && nested) ? `${nested[0]} { value }` : ''} }`).join(' ')
  return `query P($userId: String!) { user(userId: $userId) { name ${parts} } }`
}

function summar (xs){ const s=[...xs].sort((a,b)=>a-b); return { p50: s[Math.floor(s.length/2)], p95: s[Math.min(s.length-1,Math.ceil(0.95*s.length)-1)] } }
async function bench (name, fn, handle) {
  for (let i=0;i<WARMUP;i++) await fn()
  handle.reset()
  const xs=[]
  for (let i=0;i<ITER;i++){ const t=performance.now(); await fn(); xs.push(performance.now()-t) }
  const { p50, p95 } = summar(xs)
  console.log(`  ${name.padEnd(30)} p50 ${p50.toFixed(1).padStart(7)}ms  p95 ${p95.toFixed(1).padStart(7)}ms  req/iter ${(handle.stats.requests/ITER).toFixed(1).padStart(4)}  max-conc ${handle.stats.maxConcurrent}`)
  return p50
}

const handle = makeServer()
const port = await handle.listen()
const base = `http://127.0.0.1:${port}`

console.log(`\npatched v1 vs master v1 — same process, real fetch, ${LATENCY}ms/request\n`)
console.log('Profile page (user -> orders->payments, cart, notifications):')
const sdl3 = sdlFor(3), op3 = opFor(3)
const m3 = await bench('v1 master', async () => { const c = new MasterRestQL(sdl3, { default: base }, { batchInterval: 0 }); await c.execute(op3, { userId: '1' }, { useCache: false }) }, handle)
const p3 = await bench('v1 patched', async () => { const c = new PatchedRestQL(sdl3, { default: base }, { batchInterval: 0 }); await c.execute(op3, { userId: '1' }, { useCache: false }) }, handle)
await bench('native fetch (hand-optimized)', async () => {
  await (await fetch(`${base}/users/1`)).json()
  await Promise.all([
    fetch(`${base}/orders`).then(r => r.json()).then(() => fetch(`${base}/payments`).then(r => r.json())),
    fetch(`${base}/cart`).then(r => r.json()),
    fetch(`${base}/notifications`).then(r => r.json())
  ])
}, handle)
console.log(`  speedup vs master: ${(m3/p3).toFixed(2)}x\n`)

console.log('Breadth scaling (K siblings, no nested chain):')
for (const k of [2, 4, 6]) {
  const sdl = sdlFor(k, false), op = opFor(k, false)
  const m = await bench(`v1 master  K=${k}`, async () => { const c = new MasterRestQL(sdl, { default: base }, { batchInterval: 0 }); await c.execute(op, { userId: '1' }, { useCache: false }) }, handle)
  const p = await bench(`v1 patched K=${k}`, async () => { const c = new PatchedRestQL(sdl, { default: base }, { batchInterval: 0 }); await c.execute(op, { userId: '1' }, { useCache: false }) }, handle)
  console.log(`    speedup ${(m/p).toFixed(2)}x`)
}

console.log('\nDedup (two identical concurrent queries, one client, useCache:false):')
const sdl0 = sdlFor(0), op0 = opFor(0)
await bench('v1 master,  2x same query', async () => { const c = new MasterRestQL(sdl0, { default: base }, { batchInterval: 0 }); await Promise.all([c.execute(op0, { userId: '1' }, { useCache: false }), c.execute(op0, { userId: '1' }, { useCache: false })]) }, handle)
await bench('v1 patched, 2x same query', async () => { const c = new PatchedRestQL(sdl0, { default: base }, { batchInterval: 0 }); await Promise.all([c.execute(op0, { userId: '1' }, { useCache: false }), c.execute(op0, { userId: '1' }, { useCache: false })]) }, handle)
await handle.close()
