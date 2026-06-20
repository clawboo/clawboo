import { describe, expect, it } from 'vitest'

import type { OrchestrationEvent } from '../../events/schema'
import { projectFleetHealth, projectGraph } from '../graph'

let seq = 0
function ev(
  kind: OrchestrationEvent['kind'],
  fields: Partial<OrchestrationEvent>,
): OrchestrationEvent {
  seq += 1
  return {
    id: `e${seq}`,
    seq,
    ts: seq * 1000,
    kind,
    data: {},
    teamId: null,
    taskId: null,
    agentId: null,
    runtime: null,
    traceId: null,
    spanId: null,
    parentSpanId: null,
    correlationId: null,
    tenantId: null,
    ...fields,
  }
}

// A leader (a1) delegates to two specialists (a2 coding, a3 research); each
// produces cost; the coding subtask finishes done, the research one is in_review.
function buildLog(): OrchestrationEvent[] {
  seq = 0
  return [
    ev('task_created', {
      taskId: 'root',
      teamId: 'team1',
      data: { title: 'mission', status: 'todo' },
    }),
    ev('task_claimed', {
      taskId: 'root',
      agentId: 'a1',
      data: { assigneeAgentId: 'a1', assigneeRuntime: 'openclaw' },
    }),
    ev('task_created', {
      taskId: 'sub-code',
      teamId: 'team1',
      data: { title: 'write code', parentTaskId: 'root' },
    }),
    ev('task_created', {
      taskId: 'sub-research',
      teamId: 'team1',
      data: { title: 'research', parentTaskId: 'root' },
    }),
    ev('task_claimed', {
      taskId: 'sub-code',
      agentId: 'a2',
      data: { assigneeAgentId: 'a2', assigneeRuntime: 'claude-code' },
    }),
    ev('task_claimed', {
      taskId: 'sub-research',
      agentId: 'a3',
      data: { assigneeAgentId: 'a3', assigneeRuntime: 'openclaw' },
    }),
    ev('dep_linked', { taskId: 'sub-research', data: { dependsOnTaskId: 'sub-code' } }),
    ev('execution_started', {
      taskId: 'sub-code',
      agentId: 'a2',
      data: { execId: 'x1', executorType: 'claude-code' },
    }),
    ev('cost', {
      taskId: 'sub-code',
      agentId: 'a2',
      data: { costUsd: 0.12, inputTokens: 100, outputTokens: 50 },
    }),
    ev('execution_completed', {
      taskId: 'sub-code',
      agentId: 'a2',
      data: { execId: 'x1', status: 'succeeded', costUsd: 0.2 },
    }),
    ev('status_changed', { taskId: 'sub-code', data: { from: 'in_progress', to: 'done' } }),
    ev('execution_started', {
      taskId: 'sub-research',
      agentId: 'a3',
      data: { execId: 'x2', executorType: 'openclaw' },
    }),
    ev('cost', { taskId: 'sub-research', agentId: 'a3', data: { costUsd: 0.05 } }),
    ev('status_changed', {
      taskId: 'sub-research',
      data: { from: 'in_progress', to: 'in_review' },
    }),
  ]
}

describe('projectGraph', () => {
  it('folds the log into a task + agent delegation graph', () => {
    const g = projectGraph(buildLog())

    const root = g.tasks.find((t) => t.id === 'root')!
    const code = g.tasks.find((t) => t.id === 'sub-code')!
    const research = g.tasks.find((t) => t.id === 'sub-research')!
    expect(root.assigneeAgentId).toBe('a1')
    expect(code.status).toBe('done')
    expect(code.assigneeAgentId).toBe('a2')
    expect(code.runtime).toBe('claude-code')
    expect(research.status).toBe('in_review')

    // delegation (parent→child) + dependency edges
    expect(g.taskEdges).toContainEqual(
      expect.objectContaining({ source: 'root', target: 'sub-code', kind: 'delegation' }),
    )
    expect(g.taskEdges).toContainEqual(
      expect.objectContaining({ source: 'root', target: 'sub-research', kind: 'delegation' }),
    )
    expect(g.taskEdges).toContainEqual(
      expect.objectContaining({ source: 'sub-code', target: 'sub-research', kind: 'dependency' }),
    )

    // agent→agent delegation derived from parent assignees (a1 → a2, a1 → a3)
    expect(g.agentEdges).toContainEqual(
      expect.objectContaining({ source: 'a1', target: 'a2', kind: 'delegation' }),
    )
    expect(g.agentEdges).toContainEqual(
      expect.objectContaining({ source: 'a1', target: 'a3', kind: 'delegation' }),
    )
  })

  it('accounts cost without double-counting (exec total supersedes incremental)', () => {
    const g = projectGraph(buildLog())
    const code = g.tasks.find((t) => t.id === 'sub-code')!
    expect(code.costUsd).toBeCloseTo(0.2) // 0.12 incremental → 0.2 final exec total
    const a2 = g.agents.find((a) => a.id === 'a2')!
    expect(a2.costUsd).toBeCloseTo(0.2)
    const a3 = g.agents.find((a) => a.id === 'a3')!
    expect(a3.costUsd).toBeCloseTo(0.05)
  })

  it('REPLAY reproduces the graph state (the surface cannot drift)', () => {
    const log = buildLog()
    const a = projectGraph(log)
    const b = projectGraph(log.slice()) // replay over the same ordered events
    expect(JSON.stringify(b)).toBe(JSON.stringify(a))
  })
})

describe('projectFleetHealth (Gastown triage)', () => {
  it('classifies working / idle / stalled / zombie by open execution + staleness', () => {
    seq = 0
    const now = 100 * 60_000
    const log: OrchestrationEvent[] = [
      // a-working: open execution, recent event
      ev('execution_started', {
        taskId: 't-w',
        agentId: 'a-working',
        ts: now - 60_000,
        data: { execId: 'w' },
      }),
      // a-idle: opened then completed
      ev('execution_started', {
        taskId: 't-i',
        agentId: 'a-idle',
        ts: now - 10 * 60_000,
        data: { execId: 'i' },
      }),
      ev('execution_completed', {
        taskId: 't-i',
        agentId: 'a-idle',
        ts: now - 9 * 60_000,
        data: { execId: 'i', status: 'succeeded' },
      }),
      // a-stalled: open, quiet 10 min (> 5 min stall, < 30 min zombie)
      ev('execution_started', {
        taskId: 't-s',
        agentId: 'a-stalled',
        ts: now - 10 * 60_000,
        data: { execId: 's' },
      }),
      // a-zombie: open, quiet 45 min (> 30 min zombie)
      ev('execution_started', {
        taskId: 't-z',
        agentId: 'a-zombie',
        ts: now - 45 * 60_000,
        data: { execId: 'z' },
      }),
    ]
    const health = projectFleetHealth(log, now)
    expect(health.get('a-working')!.status).toBe('working')
    expect(health.get('a-idle')!.status).toBe('idle')
    expect(health.get('a-stalled')!.status).toBe('stalled')
    expect(health.get('a-zombie')!.status).toBe('zombie')
  })
})
