/** RestQL v2 core — RFC-0002. One IR, three producers, one consumer. */

export {
  IR_VERSION,
  nodeId,
  ok,
  err,
  type Binding,
  type HttpMethod,
  type HttpNodeIR,
  type NodeId,
  type NodeIR,
  type QueryIR,
  type Result
} from './ir/schema'
export { validate, type IRError } from './ir/validate'
export { plan, type ExecutionPlan, type PlanError } from './plan/planner'
export {
  execute,
  type ExecuteOptions,
  type NodeError,
  type NodeResult,
  type QueryResult
} from './exec/executor'
export { fetchTransport, type ResolvedRequest, type Transport, type TransportResult } from './exec/transport'
export { query, http, from, type NodeBuilder, type QueryBuilder } from './builder/builder'
