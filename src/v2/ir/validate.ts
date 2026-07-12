import {
  HTTP_METHODS,
  IR_VERSION,
  err,
  ok,
  type HttpMethod,
  type NodeIR,
  type QueryIR,
  type Result
} from './schema'

export type IRError =
  | { kind: 'not-an-object' }
  | { kind: 'unsupported-version'; found: unknown }
  | { kind: 'missing-nodes' }
  | { kind: 'invalid-node'; node: string; reason: string }
  | { kind: 'key-id-mismatch'; key: string; id: unknown }
  | { kind: 'invalid-method'; node: string; found: unknown }
  | { kind: 'unknown-node-ref'; node: string; ref: string }
  | { kind: 'binding-without-dependency'; node: string; binding: string; from: string }

function isRecord (value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function isHttpMethod (value: unknown): value is HttpMethod {
  return typeof value === 'string' && (HTTP_METHODS as readonly string[]).includes(value)
}

/** RFC-0002 §5: `validate(unknown): Result` — never throws, collects all errors in one pass. */
export function validate (input: unknown): Result<QueryIR, IRError[]> {
  if (!isRecord(input)) return err([{ kind: 'not-an-object' }])

  const errors: IRError[] = []

  if (input.version !== IR_VERSION) {
    return err([{ kind: 'unsupported-version', found: input.version }])
  }
  if (!isRecord(input.nodes)) {
    return err([{ kind: 'missing-nodes' }])
  }

  const nodeKeys = new Set(Object.keys(input.nodes))

  for (const [key, raw] of Object.entries(input.nodes)) {
    if (!isRecord(raw)) {
      errors.push({ kind: 'invalid-node', node: key, reason: 'node is not an object' })
      continue
    }
    if (raw.kind !== 'http') {
      errors.push({ kind: 'invalid-node', node: key, reason: `unknown kind: ${String(raw.kind)}` })
      continue
    }
    if (raw.id !== key) {
      errors.push({ kind: 'key-id-mismatch', key, id: raw.id })
    }
    if (!isRecord(raw.request) || typeof raw.request.url !== 'string') {
      errors.push({ kind: 'invalid-node', node: key, reason: 'request.url must be a string' })
    } else if (!isHttpMethod(raw.request.method)) {
      errors.push({ kind: 'invalid-method', node: key, found: raw.request.method })
    }
    if (!Array.isArray(raw.dependsOn) || raw.dependsOn.some((d) => typeof d !== 'string')) {
      errors.push({ kind: 'invalid-node', node: key, reason: 'dependsOn must be string[]' })
      continue
    }

    const deps = raw.dependsOn as string[]
    for (const ref of deps) {
      if (!nodeKeys.has(ref)) errors.push({ kind: 'unknown-node-ref', node: key, ref })
    }

    if (raw.bindings !== undefined) {
      if (!isRecord(raw.bindings)) {
        errors.push({ kind: 'invalid-node', node: key, reason: 'bindings must be an object' })
        continue
      }
      for (const [bindingName, binding] of Object.entries(raw.bindings)) {
        if (!isRecord(binding) || typeof binding.from !== 'string' || typeof binding.path !== 'string') {
          errors.push({ kind: 'invalid-node', node: key, reason: `binding "${bindingName}" must be { from, path }` })
          continue
        }
        if (!deps.includes(binding.from)) {
          errors.push({
            kind: 'binding-without-dependency',
            node: key,
            binding: bindingName,
            from: binding.from
          })
        }
      }
    }
  }

  if (errors.length > 0) return err(errors)
  return ok(input as unknown as QueryIR)
}
