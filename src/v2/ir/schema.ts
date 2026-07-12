/** RFC-0002 §5 — the IR is pure, JSON-serializable data. One IR, three producers. */

export const IR_VERSION = '2.0' as const

export type NodeId = string & { readonly __brand: 'NodeId' }

/** Sole permitted brand cast (RFC-0002 §9). */
export function nodeId (raw: string): NodeId {
  return raw as NodeId
}

export type Result<T, E> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: E }

export function ok<T> (value: T): { ok: true; value: T } {
  return { ok: true, value }
}

export function err<E> (error: E): { ok: false; error: E } {
  return { ok: false, error }
}

export const HTTP_METHODS = ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const
export type HttpMethod = (typeof HTTP_METHODS)[number]

export interface Binding {
  readonly from: NodeId
  readonly path: string
}

export interface HttpNodeIR {
  readonly kind: 'http'
  readonly id: NodeId
  readonly request: {
    readonly method: HttpMethod
    readonly url: string
  }
  readonly dependsOn: readonly NodeId[]
  readonly bindings?: Readonly<Record<string, Binding>>
  readonly select?: readonly string[]
}

/** Discriminated union; future kinds (grpc, graphql) extend here — v2.1 */
export type NodeIR = HttpNodeIR

export interface QueryIR {
  readonly version: typeof IR_VERSION
  readonly nodes: Readonly<Record<NodeId, NodeIR>>
}
