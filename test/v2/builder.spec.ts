import { describe, it, expect } from 'vitest'
import { IR_VERSION } from '../../src/v2/ir/schema'
import { query, http, from } from '../../src/v2/builder/builder'

describe('builder', () => {
  it('builds IR deep-equal to the handwritten fixture (builder is a front door, not a dialect)', () => {
    const result = query()
      .node('user', http.get('/users/{id}', { id: 1 }))
      .node('orders', http.get('/users/{userId}/orders').bind('userId', from('user', 'id')))
      .node('cart', http.get('/users/{userId}/cart').bind('userId', from('user', 'id')))
      .build()

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.value).toEqual({
      version: IR_VERSION,
      nodes: {
        user: {
          kind: 'http',
          id: 'user',
          request: { method: 'GET', url: '/users/1' },
          dependsOn: []
        },
        orders: {
          kind: 'http',
          id: 'orders',
          request: { method: 'GET', url: '/users/{userId}/orders' },
          dependsOn: ['user'],
          bindings: { userId: { from: 'user', path: 'id' } }
        },
        cart: {
          kind: 'http',
          id: 'cart',
          request: { method: 'GET', url: '/users/{userId}/cart' },
          dependsOn: ['user'],
          bindings: { userId: { from: 'user', path: 'id' } }
        }
      }
    })
  })

  it('derives dependsOn from bindings — the user never writes edges by hand', () => {
    const result = query()
      .node('a', http.get('/a'))
      .node('b', http.get('/b/{x}/{y}').bind('x', from('a', 'id')).bind('y', from('a', 'other')))
      .build()

    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.value.nodes.b?.dependsOn).toEqual(['a']) // deduped
    }
  })

  it('rejects a dangling from() reference at build time via validate()', () => {
    const result = query()
      .node('b', http.get('/b/{x}').bind('x', from('ghost', 'id')))
      .build()

    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error[0]).toMatchObject({ kind: 'unknown-node-ref', ref: 'ghost' })
    }
  })

  it('builder steps are immutable — branching from a base builder does not share state', () => {
    const base = query().node('a', http.get('/a'))
    const withB = base.node('b', http.get('/b'))
    const withC = base.node('c', http.get('/c'))

    const b = withB.build()
    const c = withC.build()
    expect(b.ok && Object.keys(b.value.nodes)).toEqual(['a', 'b'])
    expect(c.ok && Object.keys(c.value.nodes)).toEqual(['a', 'c'])
  })

  it('supports non-GET methods', () => {
    const result = query().node('create', http.post('/users')).build()
    expect(result.ok).toBe(true)
    if (result.ok) expect(result.value.nodes.create?.request.method).toBe('POST')
  })
})
