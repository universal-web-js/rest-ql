import type { HttpMethod } from '../ir/schema'

export interface ResolvedRequest {
  readonly method: HttpMethod
  readonly url: string
}

export type TransportResult =
  | { ok: true; data: unknown }
  | { ok: false; error: { message: string; status?: number } }

/** RFC-0002 §7 — the ONLY seam that touches the network. */
export interface Transport {
  execute (req: ResolvedRequest, signal: AbortSignal): Promise<TransportResult>
}

/** Default adapter. Core modules never import fetch directly — only this adapter does. */
export function fetchTransport (init?: { headers?: Record<string, string> }): Transport {
  return {
    async execute (req, signal) {
      try {
        const response = await fetch(req.url, {
          method: req.method,
          ...(init?.headers !== undefined ? { headers: init.headers } : {}),
          signal
        })
        if (!response.ok) {
          return {
            ok: false,
            error: { message: `Request to ${req.url} failed`, status: response.status }
          }
        }
        return { ok: true, data: await response.json() }
      } catch (cause) {
        return {
          ok: false,
          error: { message: cause instanceof Error ? cause.message : 'transport failure' }
        }
      }
    }
  }
}
