import { describe, expect, it } from 'vitest'

import type { OrchestrationEvent } from '../events/schema'
import { summarizeMetrics } from '../metrics'

let seq = 0
function ev(
  kind: OrchestrationEvent['kind'],
  fields: Partial<OrchestrationEvent>,
): OrchestrationEvent {
  seq += 1
  return { id: `e${seq}`, seq, ts: seq * 1000, kind, data: {}, ...fields } as OrchestrationEvent
}

describe('summarizeMetrics', () => {
  it('aggregates cost, tokens, tool-error-rate, and active agents', () => {
    seq = 0
    const m = summarizeMetrics([
      ev('cost', { agentId: 'a1', data: { costUsd: 0.1, inputTokens: 200, outputTokens: 100 } }),
      ev('cost', { agentId: 'a2', data: { costUsd: 0.3, inputTokens: 0, outputTokens: 50 } }),
      ev('tool_result', {
        agentId: 'a1',
        data: { toolCallId: 't1', name: 'edit', isError: false },
      }),
      ev('tool_result', { agentId: 'a1', data: { toolCallId: 't2', name: 'bash', isError: true } }),
    ])
    expect(m.totalCostUsd).toBeCloseTo(0.4)
    expect(m.inputTokens).toBe(200)
    expect(m.outputTokens).toBe(150)
    expect(m.toolCalls).toBe(2)
    expect(m.toolErrors).toBe(1)
    expect(m.toolErrorRate).toBeCloseTo(0.5)
    expect(m.activeAgents).toBe(2)
  })

  it('toolErrorRate is 0 with no tool results', () => {
    expect(summarizeMetrics([]).toolErrorRate).toBe(0)
  })

  it('falls back to execution_completed cost/tokens for a run that reports no incremental cost event', () => {
    seq = 0
    // A completion-only-cost runtime: no mid-run `cost` event, only the final
    // total on `execution_completed`. The trace metrics must reflect the real
    // cost (matching the graph projection), not $0.
    const m = summarizeMetrics([
      ev('execution_completed', {
        taskId: 't1',
        data: {
          execId: 'x1',
          status: 'succeeded',
          costUsd: 0.25,
          inputTokens: 500,
          outputTokens: 80,
        },
      }),
    ])
    expect(m.totalCostUsd).toBeCloseTo(0.25)
    expect(m.inputTokens).toBe(500)
    expect(m.outputTokens).toBe(80)
  })

  it('does not double-count: reconciles incremental cost events with the execution_completed total (max per run)', () => {
    seq = 0
    const m = summarizeMetrics([
      ev('cost', { taskId: 't1', data: { costUsd: 0.1, inputTokens: 200, outputTokens: 40 } }),
      // The exec total (0.25) is authoritative — only the delta beyond the cost
      // event is added, NOT 0.1 + 0.25.
      ev('execution_completed', {
        taskId: 't1',
        data: {
          execId: 'x1',
          status: 'succeeded',
          costUsd: 0.25,
          inputTokens: 500,
          outputTokens: 80,
        },
      }),
    ])
    expect(m.totalCostUsd).toBeCloseTo(0.25)
    expect(m.inputTokens).toBe(500)
    expect(m.outputTokens).toBe(80)
  })
})
