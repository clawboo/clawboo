// Key metrics derived from the event log — the runtime signals the fleet-health /
// triage view and the cost overlays read. Pure folds over an ordered event list.

import type {
  CostData,
  ExecutionCompletedData,
  OrchestrationEvent,
  OrchestrationEventKind,
  ToolResultData,
} from './events/schema'

function dataOf<T>(ev: OrchestrationEvent): T {
  return (ev.data ?? {}) as T
}

export interface ObsMetrics {
  totalCostUsd: number
  inputTokens: number
  outputTokens: number
  /** failed tool results / total tool results (0 when none). */
  toolErrorRate: number
  toolCalls: number
  toolErrors: number
  eventCounts: Partial<Record<OrchestrationEventKind, number>>
  activeAgents: number
  /** Output tokens per minute over the observed window (0 when window < 1s). */
  tokensPerMinute: number
}

/** Aggregate metrics from an ordered event list. */
export function summarizeMetrics(events: readonly OrchestrationEvent[]): ObsMetrics {
  let toolCalls = 0
  let toolErrors = 0
  const eventCounts: Partial<Record<OrchestrationEventKind, number>> = {}
  const agents = new Set<string>()
  let minTs = Number.POSITIVE_INFINITY
  let maxTs = 0

  // Cost/tokens are reconciled PER RUN (keyed by taskId), mirroring projectGraph:
  // `cost` events are incremental, `execution_completed` carries the run's FINAL
  // total. A runtime that reports cost only at completion (no mid-run `cost`
  // event) would otherwise read $0 / 0 tokens here while the graph showed the real
  // total. Per task we take max(sum of cost events, execution_completed total), so
  // both code paths converge regardless of how a runtime reports cost.
  const perRun = new Map<string, { cost: number; input: number; output: number }>()
  const bucket = (
    taskId: string | null | undefined,
  ): { cost: number; input: number; output: number } => {
    const key = taskId ?? ''
    let b = perRun.get(key)
    if (!b) {
      b = { cost: 0, input: 0, output: 0 }
      perRun.set(key, b)
    }
    return b
  }

  for (const ev of events) {
    eventCounts[ev.kind] = (eventCounts[ev.kind] ?? 0) + 1
    if (ev.agentId) agents.add(ev.agentId)
    if (ev.ts < minTs) minTs = ev.ts
    if (ev.ts > maxTs) maxTs = ev.ts
    if (ev.kind === 'cost') {
      const d = dataOf<CostData>(ev)
      const b = bucket(ev.taskId)
      b.cost += d.costUsd ?? 0
      b.input += d.inputTokens ?? 0
      b.output += d.outputTokens ?? 0
    } else if (ev.kind === 'execution_completed') {
      const d = dataOf<ExecutionCompletedData>(ev)
      const b = bucket(ev.taskId)
      // The execution total is authoritative for the run — take it only when it
      // exceeds what incremental `cost` events already accounted (avoids double
      // counting; supplies the value when there were no `cost` events at all).
      if (typeof d.costUsd === 'number' && d.costUsd > b.cost) b.cost = d.costUsd
      if (typeof d.inputTokens === 'number' && d.inputTokens > b.input) b.input = d.inputTokens
      if (typeof d.outputTokens === 'number' && d.outputTokens > b.output) b.output = d.outputTokens
    } else if (ev.kind === 'tool_result') {
      toolCalls += 1
      if (dataOf<ToolResultData>(ev).isError) toolErrors += 1
    }
  }

  let totalCostUsd = 0
  let inputTokens = 0
  let outputTokens = 0
  for (const b of perRun.values()) {
    totalCostUsd += b.cost
    inputTokens += b.input
    outputTokens += b.output
  }

  const windowMs = maxTs > minTs ? maxTs - minTs : 0
  const tokensPerMinute = windowMs >= 1000 ? (outputTokens / windowMs) * 60_000 : 0

  return {
    totalCostUsd,
    inputTokens,
    outputTokens,
    toolErrorRate: toolCalls > 0 ? toolErrors / toolCalls : 0,
    toolCalls,
    toolErrors,
    eventCounts,
    activeAgents: agents.size,
    tokensPerMinute,
  }
}
