import { describe, expect, it } from 'vitest'

import {
  ORCHESTRATION_EVENT_KINDS,
  orchestrationEventSchema,
  parseOrchestrationEvent,
} from '../schema'

describe('orchestration event schema', () => {
  it('validates a well-formed event and defaults data to {}', () => {
    const ev = parseOrchestrationEvent({ id: 'e1', ts: 1, kind: 'task_created', taskId: 't1' })
    expect(ev.data).toEqual({})
    expect(ev.kind).toBe('task_created')
    expect(ev.taskId).toBe('t1')
  })

  it('is permissive about data shape (never drops an event on data drift)', () => {
    const ev = parseOrchestrationEvent({
      id: 'e2',
      ts: 2,
      kind: 'tool_call',
      data: { toolCallId: 'tc', name: 'edit', input: { path: 'x' }, extraUnknownKey: 42 },
    })
    expect((ev.data as Record<string, unknown>)['extraUnknownKey']).toBe(42)
  })

  it('rejects an unknown kind', () => {
    const r = orchestrationEventSchema.safeParse({ id: 'e', ts: 1, kind: 'not_a_kind' })
    expect(r.success).toBe(false)
  })

  it('requires id + ts + kind', () => {
    expect(orchestrationEventSchema.safeParse({ kind: 'cost', ts: 1 }).success).toBe(false)
    expect(orchestrationEventSchema.safeParse({ id: 'e', kind: 'cost' }).success).toBe(false)
  })

  it('covers all 23 kinds', () => {
    expect(ORCHESTRATION_EVENT_KINDS).toHaveLength(23)
  })

  it('validates a routine_fired event with its ledger data', () => {
    const ev = parseOrchestrationEvent({
      id: 'e4',
      ts: 4,
      kind: 'routine_fired',
      agentId: 'a1',
      data: { scheduledRunId: 'r1', cronSpec: '0 9 * * *', scheduledBy: 'clawboo' },
    })
    expect(ev.kind).toBe('routine_fired')
    expect(ev.data['scheduledRunId']).toBe('r1')
  })

  it('validates a session_rotated event with its lineage data', () => {
    const ev = parseOrchestrationEvent({
      id: 'e3',
      ts: 3,
      kind: 'session_rotated',
      taskId: 't1',
      traceId: 't1',
      data: { from: 'sk', to: 'sk:r1', reason: 'max_turns', tokensUsed: 180_000, rotationIndex: 1 },
    })
    expect(ev.kind).toBe('session_rotated')
    expect((ev.data as Record<string, unknown>)['to']).toBe('sk:r1')
    expect(ORCHESTRATION_EVENT_KINDS).toContain('session_rotated')
  })

  it('validates the team-chat lifecycle kinds (post / speaker / turn-bound)', () => {
    const post = parseOrchestrationEvent({
      id: 'e5',
      ts: 5,
      kind: 'team_chat_post',
      teamId: 'tm1',
      agentId: 'a2',
      data: { roomId: 'team:tm1', seq: 1, authorAgentId: 'a2', postKind: 'peer' },
    })
    expect(post.kind).toBe('team_chat_post')
    expect((post.data as Record<string, unknown>)['authorAgentId']).toBe('a2')

    const speaker = parseOrchestrationEvent({
      id: 'e6',
      ts: 6,
      kind: 'speaker_selected',
      data: {
        roomId: 'team:tm1',
        speakerAgentId: 'a3',
        policy: 'leader-nominated',
        exchangeTurn: 1,
      },
    })
    expect(speaker.kind).toBe('speaker_selected')

    const bound = parseOrchestrationEvent({
      id: 'e7',
      ts: 7,
      kind: 'turn_bound_hit',
      data: { roomId: 'team:tm1', reason: 'max_turns', maxExchangeTurns: 5, turnsTaken: 5 },
    })
    expect(bound.kind).toBe('turn_bound_hit')
    for (const k of ['team_chat_post', 'speaker_selected', 'turn_bound_hit'] as const) {
      expect(ORCHESTRATION_EVENT_KINDS).toContain(k)
    }
  })
})
