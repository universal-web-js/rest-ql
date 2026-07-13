/**
 * CHARACTERIZATION SUITE — RFC-0002 Phase 0
 *
 * Pins the CURRENT observable behavior of v1 through its public surface:
 *   new RestQL(sdl, baseUrls, options).execute(operationString, variables)
 *
 * These tests document existing behavior, including quirks.
 * They are a regression lock for v2 work. Do not "fix" v1 to satisfy them.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { RestQL } from '../../src/core/RestQL'
import { ValidationError } from '../../src/core/validation/errors'

interface RecordedCall {
  url: string
  method: string
  body: string | undefined
}

const calls: RecordedCall[] = []

function jsonResponse (payload: unknown): Response {
  const response = {
    ok: true,
    status: 200,
    json: () => Promise.resolve(payload),
    clone: () => jsonResponse(payload)
  }
  return response as unknown as Response
}

/** Scripted fetch stub: route by URL substring, record call order. */
function stubFetch (routes: Array<{ match: string; payload: unknown }>): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      calls.push({
        url,
        method: String(init.method),
        body: typeof init.body === 'string' ? init.body : undefined
      })
      const route = routes.find((r) => url.includes(r.match))
      if (!route) throw new Error(`Unrouted fetch in test: ${url}`)
      return jsonResponse(route.payload)
    })
  )
}

const SDL = `
  type User {
    id: String @from("user_id")
    name: String @from("full_name")
    email: String @from("contact_info.email")
    address: Address @from("location")
    order: Order @from("order_ref")

    @endpoint(GET, "/users/{userId}", "data")
    @endpoint(POST, "/users", "data")
    @endpoint(PUT, "/users/{userId}", "data")
    @endpoint(PATCH, "/users/{userId}", "data")
    @endpoint(DELETE, "/users/{userId}", "data")
  }

  type Order {
    total: Int @from("total_amount")

    @endpoint(GET, "/orders", "data")
  }

  type Address {
    city: String
    street: String @from("street_name")
  }
`

const BASE_URLS = { default: 'https://api.example.com' }

const USER_PAYLOAD = {
  data: {
    user_id: 'u-1',
    full_name: 'Sippi',
    contact_info: { email: 's@example.com' },
    location: { city: 'Wako', street_name: 'Main' },
    order_ref: { placeholder: true },
    secret_field: 'must-not-leak'
  }
}

const ORDER_PAYLOAD = { data: { total_amount: 42 } }

function makeClient (): RestQL {
  return new RestQL(SDL, BASE_URLS, { batchInterval: 1 })
}

beforeEach(() => {
  calls.length = 0
})

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('v1 characterization: queries', () => {
  it('resolves a simple query: @from mapping, dot-path extraction, dataPath, path variables', async () => {
    stubFetch([{ match: '/users', payload: USER_PAYLOAD }])
    const restql = makeClient()

    const result = await restql.execute(
      `query GetUser($userId: String!) {
        user(userId: $userId) {
          id
          name
          email
        }
      }`,
      { userId: 'u-1' }
    )

    expect(calls[0]?.url).toContain('https://api.example.com/users/u-1')
    expect(calls[0]?.method).toBe('GET')
    expect(result.shapedData.user).toEqual({
      id: 'u-1',
      name: 'Sippi',
      email: 's@example.com'
    })
  })

  it('cherry-picks: unrequested fields are excluded from shaped output', async () => {
    stubFetch([{ match: '/users', payload: USER_PAYLOAD }])
    const restql = makeClient()

    const result = await restql.execute(
      `query Q($userId: String!) { user(userId: $userId) { name } }`,
      { userId: 'u-1' }
    )

    expect(result.shapedData.user).toEqual({ name: 'Sippi' })
    expect(result.shapedData.user).not.toHaveProperty('secret_field')
    expect(result.shapedData.user).not.toHaveProperty('id')
  })

  it('shapes nested VALUE types (no endpoint) from the parent payload without extra fetches', async () => {
    stubFetch([{ match: '/users', payload: USER_PAYLOAD }])
    const restql = makeClient()

    const result = await restql.execute(
      `query Q($userId: String!) {
        user(userId: $userId) {
          address { city street }
        }
      }`,
      { userId: 'u-1' }
    )

    expect(result.shapedData.user.address).toEqual({ city: 'Wako', street: 'Main' })
    expect(calls).toHaveLength(1)
  })

  it('CHARACTERIZATION (v2 baseline): nested RESOURCE types trigger a second, SEQUENTIAL fetch', async () => {
    stubFetch([
      { match: '/users', payload: USER_PAYLOAD },
      { match: '/orders', payload: ORDER_PAYLOAD }
    ])
    const restql = makeClient()

    const result = await restql.execute(
      `query Q($userId: String!) {
        user(userId: $userId) {
          name
          order { total }
        }
      }`,
      { userId: 'u-1' }
    )

    // Two round-trips, strictly ordered: parent completes before child starts.
    // This serial resolution is Defect A in RFC-0002 §3 — the v2 planner's baseline.
    expect(calls.map((c) => new URL(c.url).pathname)).toEqual([
      '/users/u-1',
      '/orders'
    ])
    expect(result.shapedData.user.order).toEqual({ total: 42 })
  })

  it('CHARACTERIZATION: no in-flight dedup — same resource in two top-level selections fetches twice', async () => {
    stubFetch([{ match: '/users', payload: USER_PAYLOAD }])
    const restql = makeClient()

    // Two separate clients issuing the identical query concurrently (fresh cache each):
    // v1 has no request-level dedup; TTL cache only helps sequential repeats.
    const other = makeClient()
    await Promise.all([
      restql.execute(`query Q($userId: String!) { user(userId: $userId) { name } }`, { userId: 'u-1' }),
      other.execute(`query Q($userId: String!) { user(userId: $userId) { name } }`, { userId: 'u-1' })
    ])

    expect(calls).toHaveLength(2) // Defect B in RFC-0002 §3 — v2 dedup baseline
  })

  it('serves repeat queries from TTL cache (no second fetch) and bypasses with useCache:false', async () => {
    stubFetch([{ match: '/users', payload: USER_PAYLOAD }])
    const restql = makeClient()
    const op = `query Q($userId: String!) { user(userId: $userId) { name } }`

    await restql.execute(op, { userId: 'u-1' })
    await restql.execute(op, { userId: 'u-1' })
    expect(calls).toHaveLength(1)

    await restql.execute(op, { userId: 'u-1' }, { useCache: false })
    expect(calls).toHaveLength(2)
  })

  it('throws ValidationError when a required ($x: Type!) variable is missing', async () => {
    stubFetch([{ match: '/users', payload: USER_PAYLOAD }])
    const restql = makeClient()

    await expect(
      restql.execute(
        `query Q($userId: String!) { user(userId: $userId) { name } }`,
        {}
      )
    ).rejects.toThrowError(ValidationError)
    expect(calls).toHaveLength(0)
  })

  it('throws for a resource missing from the schema', async () => {
    stubFetch([])
    const restql = makeClient()

    await expect(
      restql.execute(`query Q { ghost { id } }`, {})
    ).rejects.toThrowError(/Resource "ghost" not found/)
  })
})

describe('v1 characterization: mutations', () => {
  it('maps createX → POST with resolved args as JSON body', async () => {
    stubFetch([{ match: '/users', payload: USER_PAYLOAD }])
    const restql = makeClient()

    const results = await restql.execute(
      `mutation M($name: String!) {
        createUser(full_name: $name) {
          name
        }
      }`,
      { name: 'Sippi' }
    )

    expect(calls[0]?.method).toBe('POST')
    expect(JSON.parse(calls[0]?.body ?? '{}')).toEqual({ full_name: 'Sippi' })
    expect(results).toEqual([{ name: 'Sippi' }])
  })

  it.each([
    ['updateUser', 'PUT'],
    ['patchUser', 'PATCH'],
    ['deleteUser', 'DELETE']
  ])('maps %s → %s', async (mutationName, expectedMethod) => {
    stubFetch([{ match: '/users', payload: USER_PAYLOAD }])
    const restql = makeClient()

    await restql.execute(
      `mutation M($userId: String!) { ${mutationName}(userId: $userId) { name } }`,
      { userId: 'u-1' }
    )

    expect(calls[0]?.method).toBe(expectedMethod)
    expect(calls[0]?.url).toContain('/users/u-1')
  })

  it('rejects unknown mutation prefixes', async () => {
    stubFetch([])
    const restql = makeClient()

    await expect(
      restql.execute(`mutation M { upsertUser(userId: "1") { name } }`, {})
    ).rejects.toThrowError(/Unknown mutation type/)
  })
})

describe('v1 engine improvements (perf/v1-engine)', () => {
  it('resolves SIBLING nested resources concurrently while chains stay ordered', async () => {
    const pending: Array<() => void> = []
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string, init: RequestInit) => {
        calls.push({ url, method: String(init.method), body: undefined })
        // Defer all responses; resolve manually after asserting concurrency.
        await new Promise<void>((resolve) => pending.push(resolve))
        const payload = url.includes('/users')
          ? USER_PAYLOAD
          : url.includes('/orders')
            ? ORDER_PAYLOAD
            : { data: { item_count: 3 } }
        return jsonResponse(payload)
      })
    )

    const sdlWithCart = SDL.replace(
      'order: Order @from("order_ref")',
      'order: Order @from("order_ref")\n    cart: Cart @from("cart_ref")'
    ) + `
  type Cart {
    count: Int @from("item_count")
    @endpoint(GET, "/cart", "data")
  }
`
    const restql = new RestQL(sdlWithCart, BASE_URLS, { batchInterval: 1 })
    const execution = restql.execute(
      `query Q($userId: String!) {
        user(userId: $userId) { name order { total } cart { count } }
      }`,
      { userId: 'u-1' }
    )

    // Wave 1: only the user request is in flight.
    await vi.waitFor(() => expect(calls).toHaveLength(1))
    pending.shift()!()

    // Wave 2: order AND cart are in flight TOGETHER before either resolves.
    await vi.waitFor(() => expect(calls).toHaveLength(3))
    expect(calls.map((c) => new URL(c.url).pathname).sort()).toEqual(
      ['/cart', '/orders', '/users/u-1'].sort()
    )
    pending.splice(0).forEach((resolve) => resolve())

    const result = await execution
    expect(result.shapedData.user.order).toEqual({ total: 42 })
    expect(result.shapedData.user.cart).toEqual({ count: 3 })
  })

  it('dedupes identical in-flight GETs within one client (single network call, independent bodies)', async () => {
    stubFetch([{ match: '/users', payload: USER_PAYLOAD }])
    const restql = makeClient()
    const op = `query Q($userId: String!) { user(userId: $userId) { name } }`

    const [first, second] = await Promise.all([
      restql.execute(op, { userId: 'u-1' }, { useCache: false }),
      restql.execute(op, { userId: 'u-1' }, { useCache: false })
    ])

    expect(calls).toHaveLength(1)
    expect(first.shapedData.user).toEqual({ name: 'Sippi' })
    expect(second.shapedData.user).toEqual({ name: 'Sippi' })
  })
})
