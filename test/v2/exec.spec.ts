import { describe, it, expect } from 'vitest'
import { IR_VERSION, nodeId, type QueryIR } from '../../src/v2/ir/schema'
import { plan } from '../../src/v2/plan/planner'
import { execute } from '../../src/v2/exec/executor'
import type { ResolvedRequest, Transport, TransportResult } from '../../src/v2/exec/transport'

interface Route {
  match: string
  data?: unknown
  fail?: boolean
  delayMs?: number
}

interface CallLog {
  url: string
  startedAt: number
  endedAt: number
}

/** Scripted transport: no HTTP mocking libraries (RFC-0002 §7). */
function fakeTransport (routes: Route[]) {
  const log: CallLog[] = []
  let clock = 0
  const transport: Transport = {
    async execute (req: ResolvedRequest, signal: AbortSignal): Promise<TransportResult> {
      const startedAt = clock++
      const route = routes.find((r) => req.url.includes(r.match))
      if (!route) throw new Error(`Unrouted: ${req.url}`)
      if (route.delayMs) await new Promise((r) => setTimeout(r, route.delayMs))
      if (signal.aborted) return { ok: false, error: { message: 'aborted' } }
      log.push({ url: req.url, startedAt, endedAt: clock++ })
      if (route.fail) return { ok: false, error: { message: `boom: ${req.url}` } }
      return { ok: true, data: route.data ?? { url: req.url } }
    }
  }
  return { transport, log }
}

function buildIR (
  nodes: Record<string, { url: string; deps?: string[]; bindings?: Record<string, { from: string; path: string }> }>
): QueryIR {
  const out: Record<string, unknown> = {}
  for (const [id, spec] of Object.entries(nodes)) {
    out[id] = {
      kind: 'http',
      id: nodeId(id),
      request: { method: 'GET', url: spec.url },
      dependsOn: (spec.deps ?? []).map(nodeId),
      ...(spec.bindings
        ? { bindings: Object.fromEntries(Object.entries(spec.bindings).map(([k, b]) => [k, { from: nodeId(b.from), path: b.path }])) }
        : {})
    }
  }
  return { version: IR_VERSION, nodes: out } as QueryIR
}

function mustPlan (ir: QueryIR) {
  const result = plan(ir)
  if (!result.ok) throw new Error('plan failed in test setup')
  return result.value
}

describe('executor: waves and concurrency', () => {
  it('runs nodes within a wave concurrently (all start before any ends)', async () => {
    const ir = buildIR({
      a: { url: '/a' },
      b: { url: '/b' },
      c: { url: '/c' }
    })
    const { transport, log } = fakeTransport([
      { match: '/a', delayMs: 5 },
      { match: '/b', delayMs: 5 },
      { match: '/c', delayMs: 5 }
    ])

    const result = await execute(mustPlan(ir), ir, transport)

    expect(Object.values(result.nodes).every((n) => n.status === 'ok')).toBe(true)
    const maxStart = Math.max(...log.map((c) => c.startedAt))
    const minEnd = Math.min(...log.map((c) => c.endedAt))
    expect(maxStart).toBeLessThan(minEnd) // interleaved = concurrent, unlike v1's serial nested fetches
    expect(result.meta.waves).toBe(1)
  })

  it('executes waves strictly in order: dependency data is available to the next wave', async () => {
    const ir = buildIR({
      user: { url: '/users/1' },
      orders: {
        url: '/users/{userId}/orders',
        deps: ['user'],
        bindings: { userId: { from: 'user', path: 'id' } }
      }
    })
    const { transport, log } = fakeTransport([
      { match: '/users/1', data: { id: 'u-1' } },
      { match: '/orders', data: [{ total: 42 }] }
    ])

    const result = await execute(mustPlan(ir), ir, transport)

    expect(log.map((c) => c.url)).toEqual(['/users/1', '/users/u-1/orders'])
    const orders = result.nodes[nodeId('orders')]
    expect(orders).toEqual({ status: 'ok', data: [{ total: 42 }] })
  })

  it('resolves binding paths with array indices (orders[0].id)', async () => {
    const ir = buildIR({
      orders: { url: '/orders' },
      detail: {
        url: '/orders/{orderId}',
        deps: ['orders'],
        bindings: { orderId: { from: 'orders', path: 'items[0].id' } }
      }
    })
    const { transport, log } = fakeTransport([
      { match: '/orders/o-9', data: { deep: true } },
      { match: '/orders', data: { items: [{ id: 'o-9' }] } }
    ])

    await execute(mustPlan(ir), ir, transport)
    expect(log.at(-1)?.url).toBe('/orders/o-9')
  })
})

describe('executor: deduplication', () => {
  it('dedupes identical in-flight requests into one transport call and reports the saving', async () => {
    const ir = buildIR({
      a: { url: '/users/15' },
      b: { url: '/users/15' },
      c: { url: '/users/15' },
      d: { url: '/other' }
    })
    const { transport, log } = fakeTransport([
      { match: '/users/15', data: { id: 15 } },
      { match: '/other', data: {} }
    ])

    const result = await execute(mustPlan(ir), ir, transport)

    expect(log.filter((c) => c.url === '/users/15')).toHaveLength(1)
    expect(result.meta.dedupedRequests).toBe(2)
    expect(result.nodes[nodeId('a')]).toEqual({ status: 'ok', data: { id: 15 } })
    expect(result.nodes[nodeId('c')]).toEqual({ status: 'ok', data: { id: 15 } })
  })
})

describe('executor: partial success', () => {
  it('marks failed node error, its dependents skipped, and siblings ok — never throws', async () => {
    const ir = buildIR({
      user: { url: '/user' },
      inventory: { url: '/inventory' },
      recommendations: {
        url: '/recs/{sku}',
        deps: ['inventory'],
        bindings: { sku: { from: 'inventory', path: 'sku' } }
      }
    })
    const { transport } = fakeTransport([
      { match: '/user', data: { id: 1 } },
      { match: '/inventory', fail: true },
      { match: '/recs', data: {} }
    ])

    const result = await execute(mustPlan(ir), ir, transport)

    expect(result.nodes[nodeId('user')]?.status).toBe('ok')
    expect(result.nodes[nodeId('inventory')]).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining('boom') }
    })
    expect(result.nodes[nodeId('recommendations')]).toEqual({
      status: 'skipped',
      reason: { dependencyFailed: 'inventory' }
    })
  })

  it('treats an unresolvable binding as a node error, not a throw', async () => {
    const ir = buildIR({
      user: { url: '/user' },
      orders: {
        url: '/orders/{userId}',
        deps: ['user'],
        bindings: { userId: { from: 'user', path: 'missing.deep.path' } }
      }
    })
    const { transport } = fakeTransport([{ match: '/user', data: { id: 1 } }])

    const result = await execute(mustPlan(ir), ir, transport)

    expect(result.nodes[nodeId('orders')]).toMatchObject({
      status: 'error',
      error: { message: expect.stringContaining('missing.deep.path') }
    })
  })

  it('propagates an external abort signal to the transport', async () => {
    const ir = buildIR({ slow: { url: '/slow' } })
    const { transport } = fakeTransport([{ match: '/slow', delayMs: 20 }])
    const controller = new AbortController()
    setTimeout(() => controller.abort(), 1)

    const result = await execute(mustPlan(ir), ir, transport, { signal: controller.signal })

    expect(result.nodes[nodeId('slow')]).toMatchObject({ status: 'error' })
  })
})
