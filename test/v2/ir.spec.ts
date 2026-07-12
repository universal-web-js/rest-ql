import { describe, it, expect } from 'vitest'
import { IR_VERSION, nodeId } from '../../src/v2/ir/schema'
import { validate } from '../../src/v2/ir/validate'

const validIR = {
  version: IR_VERSION,
  nodes: {
    user: {
      kind: 'http',
      id: 'user',
      request: { method: 'GET', url: '/users/{id}' },
      dependsOn: []
    },
    orders: {
      kind: 'http',
      id: 'orders',
      request: { method: 'GET', url: '/users/{userId}/orders' },
      dependsOn: ['user'],
      bindings: { userId: { from: 'user', path: 'id' } }
    }
  }
}

describe('IR validate', () => {
  it('accepts a well-formed IR', () => {
    const result = validate(validIR)
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(Object.keys(result.value.nodes)).toEqual(['user', 'orders'])
    }
  })

  it('round-trips through JSON serialization', () => {
    const first = validate(validIR)
    expect(first.ok).toBe(true)
    if (!first.ok) return
    const second = validate(JSON.parse(JSON.stringify(first.value)))
    expect(second.ok).toBe(true)
    if (second.ok) expect(second.value).toEqual(first.value)
  })

  it('rejects non-object input', () => {
    const result = validate('query { user }')
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error[0]?.kind).toBe('not-an-object')
  })

  it('rejects an unknown version', () => {
    const result = validate({ ...validIR, version: '1.0' })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error[0]?.kind).toBe('unsupported-version')
  })

  it('rejects a dependsOn reference to a missing node', () => {
    const result = validate({
      version: IR_VERSION,
      nodes: {
        a: {
          kind: 'http',
          id: 'a',
          request: { method: 'GET', url: '/a' },
          dependsOn: ['ghost']
        }
      }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error).toEqual([
        expect.objectContaining({ kind: 'unknown-node-ref', node: 'a', ref: 'ghost' })
      ])
    }
  })

  it('rejects a binding whose "from" is not in dependsOn', () => {
    const result = validate({
      version: IR_VERSION,
      nodes: {
        a: {
          kind: 'http',
          id: 'a',
          request: { method: 'GET', url: '/a' },
          dependsOn: []
        },
        b: {
          kind: 'http',
          id: 'b',
          request: { method: 'GET', url: '/b/{x}' },
          dependsOn: [],
          bindings: { x: { from: 'a', path: 'id' } }
        }
      }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.error[0]).toMatchObject({ kind: 'binding-without-dependency', node: 'b' })
    }
  })

  it('rejects mismatched node key vs node id', () => {
    const result = validate({
      version: IR_VERSION,
      nodes: {
        a: {
          kind: 'http',
          id: 'not-a',
          request: { method: 'GET', url: '/a' },
          dependsOn: []
        }
      }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.error[0]?.kind).toBe('key-id-mismatch')
  })

  it('rejects invalid HTTP methods and collects MULTIPLE errors in one pass', () => {
    const result = validate({
      version: IR_VERSION,
      nodes: {
        a: {
          kind: 'http',
          id: 'a',
          request: { method: 'FETCH', url: '/a' },
          dependsOn: ['ghost']
        }
      }
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      const kinds = result.error.map((e) => e.kind).sort()
      expect(kinds).toEqual(['invalid-method', 'unknown-node-ref'])
    }
  })
})

describe('nodeId brand constructor', () => {
  it('brands plain strings for boundary crossing', () => {
    const id = nodeId('user')
    expect(id).toBe('user')
  })
})
