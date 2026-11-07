// Needs you reads what a task waits on (waiting_on) and who it is assigned to.

import { describe, expect, it } from 'vitest'

import { taskAttention } from '../attention'

const runs = (...statuses: string[]) => statuses.map((status) => ({ status }))
const BOUND = 'run-1:deleg:agent:a2:reflectTo:leader'

describe('taskAttention: waiting on other work stays out of Needs you', () => {
  it('a task waiting on another task', () => {
    expect(
      taskAttention({
        status: 'blocked',
        execs: runs('succeeded'),
        waitingOn: { kind: 'task', taskId: 't2' },
      }),
    ).toBeNull()
  })

  it('a task waiting on its own sub-tasks', () => {
    expect(
      taskAttention({
        status: 'blocked',
        execs: runs('succeeded'),
        waitingOn: { kind: 'subtasks' },
      }),
    ).toBeNull()
  })

  it('reads the column value as stored', () => {
    expect(
      taskAttention({ status: 'blocked', execs: [], waitingOn: '{"kind":"subtasks"}' }),
    ).toBeNull()
  })
})

describe('taskAttention: person-facing reasons', () => {
  it('a question waits for your answer', () => {
    expect(
      taskAttention({
        status: 'blocked',
        execs: runs('succeeded'),
        waitingOn: { kind: 'question', questionId: 'q1' },
      }),
    ).toEqual({ reason: 'question', failedRuns: 0, questionId: 'q1' })
  })

  it('says what a person must do', () => {
    expect(
      taskAttention({
        status: 'blocked',
        execs: runs('succeeded'),
        waitingOn: { kind: 'person', need: 'Approve the copy' },
      }),
    ).toEqual({ reason: 'blocked', failedRuns: 0, detail: 'Approve the copy' })
  })

  it('a check that could not run needs review', () => {
    expect(
      taskAttention({
        status: 'blocked',
        execs: runs('succeeded'),
        waitingOn: { kind: 'verification', state: 'could_not_run' },
      })?.reason,
    ).toBe('needs_review')
  })

  it('a check waiting to be parked needs a person even while In review', () => {
    expect(
      taskAttention({
        status: 'in_review',
        execs: runs('running'),
        waitingOn: { kind: 'verification', state: 'park_pending' },
      })?.reason,
    ).toBe('needs_review')
    // A check that is running is the board's own work.
    expect(
      taskAttention({
        status: 'in_review',
        execs: runs('running'),
        waitingOn: { kind: 'verification', state: 'running' },
      }),
    ).toBeNull()
  })

  it('keeps reading the ledger for a failed run', () => {
    expect(
      taskAttention({ status: 'blocked', execs: runs('failed'), waitingOn: { kind: 'failure' } })
        ?.reason,
    ).toBe('failed')
  })
})

describe('taskAttention: a task assigned to a person', () => {
  it('is never filed as unassigned', () => {
    expect(taskAttention({ status: 'todo', execs: [], assigneePersonId: 'local' })).toEqual({
      reason: 'assigned',
      failedRuns: 0,
      personId: 'local',
    })
  })

  it('reads the person first, over an agent binding too', () => {
    expect(
      taskAttention({
        status: 'todo',
        sourceDelegationId: BOUND,
        execs: runs('failed', 'failed', 'failed'),
        assigneePersonId: 'p1',
      })?.reason,
    ).toBe('assigned')
  })

  it('says what a hand-back asks for, and that an agent handed it back', () => {
    expect(
      taskAttention({
        status: 'blocked',
        execs: runs('succeeded'),
        assigneePersonId: 'local',
        waitingOn: { kind: 'person', need: 'Check the deploy', personId: 'local', by: 'agent' },
      }),
    ).toEqual({
      reason: 'assigned',
      failedRuns: 0,
      personId: 'local',
      detail: 'Check the deploy',
      handedBack: true,
    })
  })

  it('leaves a parked or finished person task alone', () => {
    expect(taskAttention({ status: 'backlog', execs: [], assigneePersonId: 'local' })).toBeNull()
    expect(taskAttention({ status: 'done', execs: [], assigneePersonId: 'local' })).toBeNull()
  })

  it('an open question outranks the assignment', () => {
    expect(
      taskAttention({
        status: 'blocked',
        execs: [],
        assigneePersonId: 'local',
        waitingOn: { kind: 'question', questionId: 'q9' },
      })?.reason,
    ).toBe('question')
  })
})

describe('taskAttention: an agent said what it needs, then its run failed', () => {
  it('keeps what the person must do', () => {
    expect(
      taskAttention({
        status: 'blocked',
        execs: runs('failed'),
        waitingOn: { kind: 'person', need: 'Choose the database', by: 'agent' },
      }),
    ).toMatchObject({ reason: 'blocked', detail: 'Choose the database' })
  })

  it('a failed run with no such word still reads as failed', () => {
    expect(
      taskAttention({ status: 'blocked', execs: runs('failed'), waitingOn: { kind: 'failure' } }),
    ).toMatchObject({ reason: 'failed' })
  })
})
