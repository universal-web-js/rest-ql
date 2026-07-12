import {
  IR_VERSION,
  nodeId,
  type Binding,
  type HttpMethod,
  type HttpNodeIR,
  type QueryIR,
  type Result
} from '../ir/schema'
import { validate, type IRError } from '../ir/validate'

/** RFC-0002 §8 — the builder produces IR and nothing else. Zero execution logic. */

export function from (source: string, path: string): Binding {
  return { from: nodeId(source), path }
}

interface NodeSpec {
  readonly method: HttpMethod
  readonly url: string
  readonly bindings: Readonly<Record<string, Binding>>
}

export interface NodeBuilder {
  readonly spec: NodeSpec
  bind (name: string, binding: Binding): NodeBuilder
}

function nodeBuilder (spec: NodeSpec): NodeBuilder {
  return {
    spec,
    bind (name, binding) {
      return nodeBuilder({ ...spec, bindings: { ...spec.bindings, [name]: binding } })
    }
  }
}

function interpolateStatic (url: string, params: Readonly<Record<string, string | number>>): string {
  let interpolated = url
  for (const [key, value] of Object.entries(params)) {
    interpolated = interpolated.replaceAll(`{${key}}`, encodeURIComponent(String(value)))
  }
  return interpolated
}

function request (method: HttpMethod) {
  return (url: string, params: Readonly<Record<string, string | number>> = {}): NodeBuilder =>
    nodeBuilder({ method, url: interpolateStatic(url, params), bindings: {} })
}

export const http = {
  get: request('GET'),
  post: request('POST'),
  put: request('PUT'),
  patch: request('PATCH'),
  delete: request('DELETE')
} as const

export interface QueryBuilder {
  node (id: string, builder: NodeBuilder): QueryBuilder
  build (): Result<QueryIR, IRError[]>
}

function toNodeIR (id: string, spec: NodeSpec): HttpNodeIR {
  const dependsOn = [...new Set(Object.values(spec.bindings).map((b) => b.from))]
  return {
    kind: 'http',
    id: nodeId(id),
    request: { method: spec.method, url: spec.url },
    dependsOn,
    ...(Object.keys(spec.bindings).length > 0 ? { bindings: spec.bindings } : {})
  }
}

function queryBuilder (nodes: ReadonlyArray<readonly [string, NodeSpec]>): QueryBuilder {
  return {
    node (id, builder) {
      return queryBuilder([...nodes, [id, builder.spec] as const])
    },
    build () {
      const ir = {
        version: IR_VERSION,
        nodes: Object.fromEntries(nodes.map(([id, spec]) => [id, toNodeIR(id, spec)]))
      }
      // A builder can never emit an invalid IR (RFC-0002 §8).
      return validate(ir)
    }
  }
}

export function query (): QueryBuilder {
  return queryBuilder([])
}
