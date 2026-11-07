// What a person's wake may and may not do, as the pump decides it.

import { describe, expect, it } from 'vitest'

import { WAKE_SKIP_REASONS, wakeDecision, wakeFromPerson, type WakeDecisionInput } from '../wakes'

const base: WakeDecisionInput = {
  reason: 'person_comment',
  replays: 0,
  status: 'blocked',
  dropped: false,
  hasAgent: true,
  ready: true,
  execs: [],
  runProvenAlive: false,
  held: false,
  paused: false,
  refusal: null,
  budgetRefused: false,
  now: 1_000,
}

describe('a wake on a task whose turn is a person’s', () => {
  it.each(['person_comment', 'question_answered', 'dependency_done', 'reopened'])(
    'a person assigned: %s starts nothing',
    (reason) => {
      for (const status of ['blocked', 'todo'])
        expect(wakeDecision({ ...base, reason, status, personAssigned: true })).toEqual({
          do: 'wait',
          skip: 'person_assigned',
        })
    },
  )

  it.each(['person_comment', 'dependency_done', 'reopened'])(
    'a question still open: %s does not end the wait',
    (reason) => {
      expect(wakeDecision({ ...base, reason, waitingOnQuestion: true })).toEqual({
        do: 'wait',
        skip: 'question',
      })
    },
  )

  it('both waits are named reasons, so the drawer has words for them', () => {
    expect(WAKE_SKIP_REASONS).toContain('person_assigned')
    expect(WAKE_SKIP_REASONS).toContain('question')
  })
})

describe('the wakes a person is behind', () => {
  it.each(['question_answered', 'reopened'])('%s moves a Blocked task and is forced', (reason) => {
    expect(wakeFromPerson(reason)).toBe(true)
    expect(wakeDecision({ ...base, reason })).toEqual({
      do: 'fire',
      force: true,
      byPerson: true,
      moveToTodo: true,
    })
  })

  const stoppedRun = { status: 'cancelled' }
  const runningRun = { status: 'running' }

  it.each(['question_answered', 'reopened'])(
    '%s first starts past a Stop, and a replay honours it',
    (reason) => {
      const input = { ...base, reason, execs: [stoppedRun] }
      expect(wakeDecision(input)).toMatchObject({ do: 'fire', force: true })
      expect(wakeDecision({ ...input, replays: 1 })).toEqual({ do: 'wait', skip: 'stopped' })
    },
  )

  it('never moves a card under a run still open, even for a person', () => {
    expect(wakeDecision({ ...base, reason: 'question_answered', execs: [runningRun] })).toEqual({
      do: 'wait',
      skip: 'run_unproven',
    })
  })

  it('a task whose dependency is not done waits for it', () => {
    expect(wakeDecision({ ...base, reason: 'reopened', status: 'todo', ready: false })).toEqual({
      do: 'wait',
      skip: 'dependency',
    })
  })
})
