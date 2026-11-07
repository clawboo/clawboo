import { describe, expect, it } from 'vitest'

import { WAKE_SKIP_REASONS } from '@clawboo/board-core'

import { pendingWakeText, readPendingWake } from '../pendingWake'

describe('the line for a wake that has not reached its agent', () => {
  it('has words for every reason a wake can wait', () => {
    for (const skipReason of WAKE_SKIP_REASONS) {
      const text = pendingWakeText(
        { reason: 'person_comment', skipReason, comments: 1, held: false },
        'Ada',
      )
      expect(text, skipReason).not.toBe('On its way to Ada')
      expect(text).not.toMatch(/\u2014/)
    }
  })

  it('says a Stop holds it, before anything else', () => {
    expect(
      pendingWakeText(
        { reason: 'person_comment', skipReason: 'held', comments: 2, held: true },
        'Ada',
      ),
    ).toBe("Held by a Stop: Ada reads 2 comments on the task's next run")
  })

  it('a task waiting on other work is not waiting on a person, so it does not say so', () => {
    const wake = { reason: 'agent_comment', skipReason: 'blocked', comments: 1, held: false }
    expect(pendingWakeText(wake, 'Ada')).toBe('Waiting on you: Retry starts Ada on it')
    expect(pendingWakeText(wake, 'Ada', { onOtherWork: true })).toBe(
      'Ada reads this when the work it waits on has closed',
    )
  })

  it('reads the field defensively', () => {
    expect(readPendingWake(null)).toBeNull()
    expect(readPendingWake({ reason: 3 })).toBeNull()
    expect(readPendingWake({ reason: 'dependency_done' })).toEqual({
      reason: 'dependency_done',
      skipReason: null,
      comments: 0,
      held: false,
    })
  })
})
