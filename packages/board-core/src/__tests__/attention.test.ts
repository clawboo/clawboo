import { describe, expect, it } from 'vitest'

import { taskAttention } from '../attention'
import { MAX_AUTO_FIRES, encodeHumanAssignment } from '../dispatch'

const runs = (...statuses: string[]) => statuses.map((status) => ({ status }))
const BOUND = 'run-1:deleg:agent:a2:reflectTo:leader'

describe('taskAttention: blocked tasks always need a person', () => {
  it('names a failed run', () => {
    expect(taskAttention({ status: 'blocked', execs: runs('failed') })).toEqual({
      reason: 'failed',
      failedRuns: 1,
    })
  })

  it('names a run the watchdog ended', () => {
    expect(taskAttention({ status: 'blocked', execs: runs('failed', 'timed_out') })).toEqual({
      reason: 'timed_out',
      failedRuns: 2,
    })
  })

  it('puts a verification verdict ahead of the run outcome', () => {
    expect(
      taskAttention({ status: 'blocked', execs: runs('succeeded'), verificationBlocked: true }),
    ).toEqual({ reason: 'needs_review', failedRuns: 0 })
  })

  it('falls back to a plain block when the ledger does not explain it', () => {
    expect(taskAttention({ status: 'blocked', execs: [] })?.reason).toBe('blocked')
    expect(taskAttention({ status: 'blocked', execs: runs('succeeded') })?.reason).toBe('blocked')
  })
})

describe('taskAttention: a todo task needs a person only when nothing will fire it', () => {
  it('queued work the dispatcher will fire does not', () => {
    expect(taskAttention({ status: 'todo', sourceDelegationId: BOUND, execs: [] })).toBeNull()
    expect(
      taskAttention({
        status: 'todo',
        sourceDelegationId: encodeHumanAssignment('a2', 'n'),
        execs: [],
      }),
    ).toBeNull()
  })

  it('a released task still under the retry cap does not', () => {
    expect(
      taskAttention({ status: 'todo', sourceDelegationId: BOUND, execs: runs('timed_out') }),
    ).toBeNull()
  })

  it('a task no agent is bound to does', () => {
    expect(taskAttention({ status: 'todo', sourceDelegationId: null, execs: [] })).toEqual({
      reason: 'unassigned',
      failedRuns: 0,
    })
  })

  it('a task the user stopped does', () => {
    expect(
      taskAttention({ status: 'todo', sourceDelegationId: BOUND, execs: runs('cancelled') }),
    ).toEqual({ reason: 'stopped', failedRuns: 0 })
  })

  it('a task parked after failing MAX_AUTO_FIRES times does', () => {
    const parked = runs(...Array.from({ length: MAX_AUTO_FIRES }, () => 'failed'))
    expect(taskAttention({ status: 'todo', sourceDelegationId: BOUND, execs: parked })).toEqual({
      reason: 'failed',
      failedRuns: MAX_AUTO_FIRES,
    })
  })

  it('a task a live run still owns does not', () => {
    expect(
      taskAttention({ status: 'todo', sourceDelegationId: BOUND, execs: runs('running') }),
    ).toBeNull()
  })
})

describe('taskAttention: the reason a card shows', () => {
  it('carries the last run’s error for a failure, trimmed for a card', () => {
    const long = 'x'.repeat(400)
    const a = taskAttention({
      status: 'blocked',
      execs: [{ status: 'failed', error: '  provider out of credits  ' }],
    })
    expect(a).toEqual({ reason: 'failed', failedRuns: 1, detail: 'provider out of credits' })
    const t = taskAttention({ status: 'blocked', execs: [{ status: 'timed_out', error: long }] })
    expect(t?.detail?.length).toBe(280)
    expect(t?.detail?.endsWith('…')).toBe(true)
  })

  it('omits it when the run recorded none, and for reasons that are not failures', () => {
    expect(taskAttention({ status: 'blocked', execs: [{ status: 'failed' }] })).toEqual({
      reason: 'failed',
      failedRuns: 1,
    })
    expect(
      taskAttention({
        status: 'todo',
        sourceDelegationId: BOUND,
        execs: [{ status: 'cancelled', error: 'stopped by the user' }],
      }),
    ).toEqual({ reason: 'stopped', failedRuns: 0 })
  })
})

describe('taskAttention: every other status moves on its own', () => {
  it.each(['backlog', 'in_progress', 'in_review', 'done', 'cancelled'])('%s', (status) => {
    expect(taskAttention({ status, sourceDelegationId: null, execs: runs('failed') })).toBeNull()
  })
})
