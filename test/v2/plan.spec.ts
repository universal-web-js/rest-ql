import { describe, it, expect } from 'vitest'
import { IR_VERSION, nodeId, type QueryIR } from '../../src/v2/ir/schema'
import { plan } from '../../src/v2/plan/planner'

function ir (edges: Record<string, string[]>): QueryIR {
  const nodes: Record<string, unknown> = {}
  for (const [id, deps] of Object.entries(edges)) {
    nodes[id] = {
      kind: 'http',
      id: nodeId(id),
      request: { method: 'GET', url: `/${id}` },
      dependsOn: deps.map(nodeId)
    }
  }
  return { version: IR_VERSION, nodes } as QueryIR
}

describe('planner', () => {
  it('puts fully independent nodes into a single wave', () => {
    const result = plan(ir({ a: [], b: [], c: [] }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.waves).toEqual([['a', 'b', 'c']])
  })

  it('turns a linear chain into one wave per node', () => {
    const result = plan(ir({ a: [], b: ['a'], c: ['b'] }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.waves).toEqual([['a'], ['b'], ['c']])
  })

  it('resolves a diamond (a → b,c → d) into 3 waves', () => {
    const result = plan(ir({ a: [], b: ['a'], c: ['a'], d: ['b', 'c'] }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.waves).toEqual([['a'], ['b', 'c'], ['d']])
  })

  it('models the RFC profile-page graph: user → (orders, cart, notifications); orders → payments', () => {
    const result = plan(
      ir({
        user: [],
        orders: ['user'],
        cart: ['user'],
        notifications: ['user'],
        payments: ['orders']
      })
    )
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.waves).toEqual([
        ['user'],
        ['cart', 'notifications', 'orders'],
        ['payments']
      ])
    }
  })

  it('orders node ids deterministically within a wave', () => {
    const result = plan(ir({ zebra: [], alpha: [], mango: [] }))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.waves).toEqual([['alpha', 'mango', 'zebra']])
  })

  it('reports a cycle as PlanError with the offending nodes — never hangs', () => {
    const result = plan(ir({ a: ['c'], b: ['a'], c: ['b'], loner: [] }))
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error.kind).toBe('cycle')
      expect([...result.error.nodes].sort()).toEqual(['a', 'b', 'c'])
    }
  })

  it('handles the empty graph', () => {
    const result = plan(ir({}))
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.waves).toEqual([])
  })
})
