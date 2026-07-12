import { err, ok, type NodeId, type QueryIR, type Result } from '../ir/schema'

export interface ExecutionPlan {
  /** waves[0] has no deps; waves[n] depends only on waves[<n]. RFC-0002 §6. */
  readonly waves: ReadonlyArray<readonly NodeId[]>
}

export type PlanError = { kind: 'cycle'; nodes: readonly NodeId[] }

/** Pure function, no I/O. Kahn's algorithm with deterministic in-wave ordering. */
export function plan (ir: QueryIR): Result<ExecutionPlan, PlanError> {
  const ids = Object.keys(ir.nodes) as NodeId[]
  const remainingDeps = new Map<NodeId, Set<NodeId>>()
  const dependents = new Map<NodeId, NodeId[]>()

  for (const id of ids) {
    remainingDeps.set(id, new Set(ir.nodes[id]!.dependsOn))
    for (const dep of ir.nodes[id]!.dependsOn) {
      const list = dependents.get(dep) ?? []
      list.push(id)
      dependents.set(dep, list)
    }
  }

  const waves: NodeId[][] = []
  let frontier = ids.filter((id) => remainingDeps.get(id)!.size === 0)

  while (frontier.length > 0) {
    const wave = [...frontier].sort()
    waves.push(wave)

    const next: NodeId[] = []
    for (const done of wave) {
      for (const dependent of dependents.get(done) ?? []) {
        const deps = remainingDeps.get(dependent)!
        deps.delete(done)
        if (deps.size === 0) next.push(dependent)
      }
    }
    frontier = next
  }

  const planned = waves.reduce((count, wave) => count + wave.length, 0)
  if (planned !== ids.length) {
    const stuck = ids.filter((id) => remainingDeps.get(id)!.size > 0)
    return err({ kind: 'cycle', nodes: stuck })
  }

  return ok({ waves })
}
