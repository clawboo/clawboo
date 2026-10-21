// The rules a task follows when a person finishes it by hand (Done or
// Cancelled): which moves ask first, the day the card sits on, and the finish
// time recorded for a picked day. `verdictHoldsDone` has to agree with the
// server's `isVerdictPromotable`, or the board asks about a check the server
// lets through, or lets a move through that the server then refuses.
//
// Local-time constructors throughout, so every assertion holds in whatever time
// zone the suite runs in.

import { describe, expect, it } from 'vitest'

import { isVerdictPromotable } from '@clawboo/governance'

import type { BoardTask } from '@/lib/boardClient'

import { addDays, startOfDay, taskAnchor } from '../calendar/calendarModel'
import {
  createdAtOf,
  finishInstant,
  finishNeedFor,
  finishPromptNeeded,
  isFinishStatus,
  runningAgentId,
  runningSinceOf,
  sitsOnOtherDay,
  verdictHoldsDone,
  type FinishPromptNeed,
} from '../finishMove'

const at = (y: number, mo: number, d: number, h = 0, mi = 0, s = 0): number =>
  new Date(y, mo, d, h, mi, s).getTime()

// Wednesday 14 October 2026, mid-afternoon. The milliseconds are there so the
// finish time is seen to drop them.
const NOW = at(2026, 9, 14, 15, 20, 30) + 123
const TODAY = at(2026, 9, 14)
const YESTERDAY = at(2026, 9, 13)

function task(over: Partial<BoardTask> = {}): BoardTask {
  return {
    id: 't1',
    status: 'todo',
    title: 'Write the brief',
    createdAt: at(2026, 9, 14, 9),
    ...over,
  }
}

const withVerdict = (verification: unknown): BoardTask => task({ verification })

const attempt = (passed: unknown) => ({ deterministic: { passed } })

describe('verdictHoldsDone', () => {
  it('holds nothing when there is no verdict: the task is unverified, not failing', () => {
    expect(verdictHoldsDone(task())).toBe(false)
    expect(verdictHoldsDone(withVerdict(null))).toBe(false)
    expect(verdictHoldsDone(withVerdict(''))).toBe(false)
  })

  it('holds nothing when the stored verdict cannot be read', () => {
    expect(verdictHoldsDone(withVerdict('{not json'))).toBe(false)
  })

  it('lets a pass through', () => {
    expect(verdictHoldsDone(withVerdict(JSON.stringify({ status: 'pass' })))).toBe(false)
  })

  it('holds a fail, and any status it does not know', () => {
    expect(verdictHoldsDone(withVerdict(JSON.stringify({ status: 'fail' })))).toBe(true)
    expect(verdictHoldsDone(withVerdict(JSON.stringify({ status: 'pending' })))).toBe(true)
  })

  it('lets debt through only when the last deterministic check passed', () => {
    const debt = (attempts: unknown) =>
      verdictHoldsDone(withVerdict(JSON.stringify({ status: 'completed_with_debt', attempts })))
    expect(debt([attempt(true)])).toBe(false)
    expect(debt([attempt(false)])).toBe(true)
    expect(debt([{}])).toBe(true)
    expect(debt([])).toBe(true)
    expect(debt(undefined)).toBe(true)
    // The last attempt decides, not any earlier one.
    expect(debt([attempt(false), attempt(true)])).toBe(false)
    expect(debt([attempt(true), attempt(false)])).toBe(true)
  })

  it('reads the verdict as a JSON string or as an object', () => {
    const failed = { status: 'completed_with_debt', attempts: [attempt(false)] }
    const passed = { status: 'completed_with_debt', attempts: [attempt(true)] }
    expect(verdictHoldsDone(withVerdict(failed))).toBe(true)
    expect(verdictHoldsDone(withVerdict(JSON.stringify(failed)))).toBe(true)
    expect(verdictHoldsDone(withVerdict(passed))).toBe(false)
    expect(verdictHoldsDone(withVerdict(JSON.stringify(passed)))).toBe(false)
  })

  // The board's gate and the server's must give the same answer for every
  // verdict the server could have stored, partial or odd-shaped ones included.
  const CELLS: unknown[] = [
    {},
    { status: 'pass' },
    { status: 'pass', attempts: [attempt(false)] },
    { status: 'PASS' },
    { status: null },
    { status: 'fail' },
    { status: 'fail', attempts: [attempt(true)] },
    { status: 'pending' },
    { status: 'completed_with_debt' },
    { status: 'completed_with_debt', attempts: null },
    { status: 'completed_with_debt', attempts: [] },
    { status: 'completed_with_debt', attempts: {} },
    { status: 'completed_with_debt', attempts: [null] },
    { status: 'completed_with_debt', attempts: [{}] },
    { status: 'completed_with_debt', attempts: [{ deterministic: null }] },
    { status: 'completed_with_debt', attempts: [{ deterministic: {} }] },
    { status: 'completed_with_debt', attempts: [attempt(true)] },
    { status: 'completed_with_debt', attempts: [attempt(false)] },
    { status: 'completed_with_debt', attempts: [attempt('true')] },
    { status: 'completed_with_debt', attempts: [attempt(1)] },
    { status: 'completed_with_debt', attempts: [attempt(false), attempt(true)] },
    { status: 'completed_with_debt', attempts: [attempt(true), attempt(false)] },
    { status: 'completed_with_debt', attempts: [attempt(true)], debtNotes: [] },
    [],
  ]

  it.each(CELLS.map((cell) => [JSON.stringify(cell), cell]))(
    'agrees with the server for %s',
    (_label, cell) => {
      const serverHolds = !isVerdictPromotable(cell as Parameters<typeof isVerdictPromotable>[0])
      expect(verdictHoldsDone(withVerdict(JSON.stringify(cell)))).toBe(serverHolds)
      expect(verdictHoldsDone(withVerdict(cell))).toBe(serverHolds)
    },
  )

  // A stored cell that parses to something other than a verdict. The server holds
  // these, so the board asks before the move rather than learning it from a 409.
  it.each(['null', '42', 'true', '"pass"'])('agrees with the server for the cell %s', (cell) => {
    const serverHolds = !isVerdictPromotable(
      JSON.parse(cell) as Parameters<typeof isVerdictPromotable>[0],
    )
    expect(serverHolds).toBe(true)
    expect(verdictHoldsDone(withVerdict(cell))).toBe(true)
  })
})

describe('sitsOnOtherDay', () => {
  it('counts a card stamped ahead of this clock as today, never a day to come', () => {
    expect(sitsOnOtherDay(task({ createdAt: at(2026, 9, 15, 9) }), NOW)).toBeNull()
  })

  it('is null for a card added today', () => {
    expect(sitsOnOtherDay(task({ createdAt: at(2026, 9, 14, 0, 5) }), NOW)).toBeNull()
    expect(sitsOnOtherDay(task({ createdAt: NOW }), NOW)).toBeNull()
  })

  it('is the start of the day an open card was added on', () => {
    expect(sitsOnOtherDay(task({ createdAt: at(2026, 9, 13, 23, 59) }), NOW)).toBe(YESTERDAY)
    expect(sitsOnOtherDay(task({ createdAt: at(2026, 9, 2, 8) }), NOW)).toBe(at(2026, 9, 2))
  })

  it('follows the board’s placement: a finished card sits on the day it finished', () => {
    const done = task({
      status: 'done',
      createdAt: at(2026, 9, 1, 9),
      completedAt: at(2026, 9, 11, 17),
    })
    expect(sitsOnOtherDay(done, NOW)).toBe(at(2026, 9, 11))
    expect(sitsOnOtherDay(done, NOW)).toBe(startOfDay(taskAnchor(done, NOW)))

    const cancelledToday = task({
      status: 'cancelled',
      createdAt: at(2026, 9, 1, 9),
      completedAt: at(2026, 9, 14, 8),
    })
    expect(sitsOnOtherDay(cancelledToday, NOW)).toBeNull()
  })

  it('falls back the way the board does when a timestamp is missing', () => {
    expect(
      sitsOnOtherDay(task({ createdAt: undefined, updatedAt: at(2026, 9, 12, 10) }), NOW),
    ).toBe(at(2026, 9, 12))
    // No usable timestamp: the board draws it on today.
    expect(sitsOnOtherDay(task({ createdAt: undefined }), NOW)).toBeNull()
  })
})

describe('createdAtOf and runningSinceOf', () => {
  it('createdAtOf reads only a usable epoch', () => {
    expect(createdAtOf(task({ createdAt: at(2026, 9, 2) }))).toBe(at(2026, 9, 2))
    for (const bad of [undefined, 0, -5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(createdAtOf(task({ createdAt: bad }))).toBeNull()
    }
    expect(createdAtOf({ id: 't', status: 'todo', createdAt: '2026-10-02' } as never)).toBeNull()
  })

  it('runningSinceOf reads a positive number, else null', () => {
    expect(runningSinceOf(task({ runningSince: NOW - 60_000 }))).toBe(NOW - 60_000)
    for (const bad of [undefined, null, 0, -1, '12', Number.NaN]) {
      expect(runningSinceOf(task({ runningSince: bad }))).toBeNull()
    }
  })
})

describe('runningAgentId', () => {
  it('needs both an assigned agent and a run in progress', () => {
    expect(runningAgentId(task({ assigneeAgentId: 'ada', runningSince: NOW - 1000 }))).toBe('ada')
    expect(runningAgentId(task({ assigneeAgentId: 'ada' }))).toBeNull()
    expect(runningAgentId(task({ assigneeAgentId: 'ada', runningSince: null }))).toBeNull()
    expect(runningAgentId(task({ runningSince: NOW - 1000 }))).toBeNull()
    expect(runningAgentId(task({ assigneeAgentId: null, runningSince: NOW - 1000 }))).toBeNull()
    expect(runningAgentId(task({ assigneeAgentId: '', runningSince: NOW - 1000 }))).toBeNull()
  })
})

describe('isFinishStatus', () => {
  it('is true for Done and Cancelled only', () => {
    expect(isFinishStatus('done')).toBe(true)
    expect(isFinishStatus('cancelled')).toBe(true)
    for (const s of ['todo', 'backlog', 'in_progress', 'in_review', 'blocked', 'DONE', '']) {
      expect(isFinishStatus(s)).toBe(false)
    }
  })
})

describe('finishNeedFor', () => {
  it('asks nothing of a card added today that nobody is running', () => {
    expect(finishNeedFor(task(), 'done', NOW)).toEqual({
      to: 'done',
      otherDay: false,
      running: false,
      failedCheck: false,
    })
  })

  it('names each reason the move has to ask', () => {
    const t = task({
      createdAt: at(2026, 9, 10, 9),
      assigneeAgentId: 'ada',
      runningSince: NOW - 60_000,
      verification: JSON.stringify({ status: 'fail' }),
    })
    expect(finishNeedFor(t, 'done', NOW)).toEqual({
      to: 'done',
      otherDay: true,
      running: true,
      failedCheck: true,
    })
  })

  it('never counts a failed check against a cancel', () => {
    const t = task({ verification: JSON.stringify({ status: 'fail' }) })
    expect(finishNeedFor(t, 'cancelled', NOW).failedCheck).toBe(false)
    expect(finishNeedFor(t, 'done', NOW).failedCheck).toBe(true)
  })
})

describe('finishPromptNeeded', () => {
  const combos: Array<Omit<FinishPromptNeed, 'to'>> = []
  for (const otherDay of [false, true])
    for (const running of [false, true])
      for (const failedCheck of [false, true]) combos.push({ otherDay, running, failedCheck })

  it('always asks before a cancel, since it cannot be undone', () => {
    for (const c of combos) expect(finishPromptNeeded({ to: 'cancelled', ...c })).toBe(true)
  })

  it('asks before Done only when there is a day, a run or a failed check', () => {
    for (const c of combos) {
      const expected = c.otherDay || c.running || c.failedCheck
      expect(finishPromptNeeded({ to: 'done', ...c })).toBe(expected)
    }
  })
})

describe('finishInstant', () => {
  const longAgo = at(2026, 8, 1, 9)

  it('is now exactly for today, whatever instant of today is passed', () => {
    expect(finishInstant(TODAY, longAgo, NOW)).toBe(NOW)
    expect(finishInstant(NOW, longAgo, NOW)).toBe(NOW)
    expect(finishInstant(at(2026, 9, 14, 23, 59), null, NOW)).toBe(NOW)
  })

  it('is the same clock time on a past day, to the second', () => {
    expect(finishInstant(YESTERDAY, longAgo, NOW)).toBe(at(2026, 9, 13, 15, 20, 30))
    expect(finishInstant(at(2026, 9, 2), null, NOW)).toBe(at(2026, 9, 2, 15, 20, 30))
  })

  it('is never before the task was added', () => {
    // Added on the picked day, but later in the day than the clock reads now.
    const addedLate = at(2026, 9, 10, 18)
    expect(finishInstant(at(2026, 9, 10), addedLate, NOW)).toBe(addedLate)
    // Added earlier that day: the clock time stands.
    expect(finishInstant(at(2026, 9, 10), at(2026, 9, 10, 8), NOW)).toBe(
      at(2026, 9, 10, 15, 20, 30),
    )
  })

  it('is never after now', () => {
    expect(finishInstant(addDays(TODAY, 1), null, NOW)).toBe(NOW)
    // A creation time ahead of this clock (skew between machines) is not followed past now.
    expect(finishInstant(YESTERDAY, NOW + 3_600_000, NOW)).toBe(NOW)
  })

  it('lands within the task’s life for every day it could be picked', () => {
    for (const createdAt of [at(2026, 9, 4, 7), at(2026, 9, 4, 22), at(2026, 9, 13, 23, 59)]) {
      for (let day = startOfDay(createdAt); day <= TODAY; day = addDays(day, 1)) {
        const t = finishInstant(day, createdAt, NOW)
        expect(t).toBeGreaterThanOrEqual(createdAt)
        expect(t).toBeLessThanOrEqual(NOW)
        expect(startOfDay(t)).toBe(day)
      }
    }
  })

  // Each span crosses the daylight-saving changes of the common zones in both
  // hemispheres (Australia early October and April, Europe late October and
  // March, the United States November and March). Adding or subtracting whole
  // 24-hour days would land an hour off in any of them.
  it('keeps the clock time across a daylight-saving change', () => {
    const cases: Array<{ day: number; now: number }> = [
      { day: at(2026, 8, 30), now: at(2026, 10, 3, 14, 30) },
      { day: at(2026, 2, 1), now: at(2026, 3, 8, 9, 15) },
    ]
    for (const { day, now } of cases) {
      const t = new Date(finishInstant(day, null, now))
      const clock = new Date(now)
      expect([t.getFullYear(), t.getMonth(), t.getDate()]).toEqual([
        new Date(day).getFullYear(),
        new Date(day).getMonth(),
        new Date(day).getDate(),
      ])
      expect([t.getHours(), t.getMinutes()]).toEqual([clock.getHours(), clock.getMinutes()])
    }
  })
})
