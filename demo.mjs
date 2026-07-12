// RFC-0002 demo: profile page — user → (orders, cart, notifications), orders → payments,
// plus a duplicate /users/1 request to show dedup. 50ms simulated latency per request.
import { query, http, from, plan, execute } from './src/v2/index.ts'

const LATENCY = 50
const transport = {
  async execute(req) {
    await new Promise(r => setTimeout(r, LATENCY))
    const data = {
      '/users/1': { id: 'u-1' },
      '/users/u-1/orders': { items: [{ id: 'o-9', total: 120 }] },
      '/users/u-1/cart': { items: 3 },
      '/users/u-1/notifications': { unread: 2 },
      '/orders/o-9/payments': { status: 'paid' },
    }[req.url]
    return { ok: true, data }
  }
}

const built = query()
  .node('user',          http.get('/users/{id}', { id: 1 }))
  .node('userAgain',     http.get('/users/{id}', { id: 1 }))  // duplicate — dedup demo
  .node('orders',        http.get('/users/{userId}/orders').bind('userId', from('user', 'id')))
  .node('cart',          http.get('/users/{userId}/cart').bind('userId', from('user', 'id')))
  .node('notifications', http.get('/users/{userId}/notifications').bind('userId', from('user', 'id')))
  .node('payments',      http.get('/orders/{orderId}/payments').bind('orderId', from('orders', 'items[0].id')))
  .build()

if (!built.ok) throw new Error(JSON.stringify(built.error))
const planned = plan(built.value)
if (!planned.ok) throw new Error(JSON.stringify(planned.error))

console.log('Waves:', JSON.stringify(planned.value.waves))
const t0 = performance.now()
const result = await execute(planned.value, built.value, transport)
const elapsed = Math.round(performance.now() - t0)

const nodeCount = Object.keys(built.value.nodes).length
console.log(`\nv1 (serial nested resolution): ~${nodeCount * LATENCY}ms (${nodeCount} sequential round-trips)`)
console.log(`v2 (waves + dedup):            ${elapsed}ms (${planned.value.waves.length} waves)`)
console.log(`Requests deduped:              ${result.meta.dedupedRequests}`)
console.log(`payments result:               ${JSON.stringify(result.nodes.payments)}`)
