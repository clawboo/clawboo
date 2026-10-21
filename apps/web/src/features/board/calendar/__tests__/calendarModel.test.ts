import { describe, expect, it } from 'vitest'

import {
  ALL_ROW,
  bucketAll,
  addDays,
  bucketRuns,
  bucketTasks,
  buildRange,
  dayKey,
  landingAnchor,
  localeWeekStart,
  localeWeekend,
  pickShown,
  rangeBounds,
  shiftFocus,
  startOfDay,
  startOfMonth,
  startOfWeek,
  taskAnchor,
} from '../calendarModel'

// Local-time constructors throughout, so every assertion holds in whatever time
// zone the suite runs in. Oct 2026: the 12th is a Monday.
const at = (y: number, mo: number, d: number, h = 0, mi = 0): number =>
  new Date(y, mo, d, h, mi).getTime()
const MON = at(2026, 9, 12)

describe('day arithmetic', () => {
  it('startOfDay is local midnight', () => {
    const d = new Date(startOfDay(at(2026, 9, 14, 17, 45)))
    expect([d.getHours(), d.getMinutes(), d.getDate()]).toEqual([0, 0, 14])
  })

  it('addDays stays on midnight across a daylight-saving change', () => {
    // Walk 60 days from late September: covers the autumn change in both
    // hemispheres' common zones and must never drift off midnight.
    let t = at(2026, 8, 20)
    for (let i = 0; i < 60; i++) {
      t = addDays(t, 1)
      expect(new Date(t).getHours()).toBe(0)
    }
    expect(dayKey(t)).toBe('2026-11-19')
  })

  it('dayKey is zero-padded local date', () => {
    expect(dayKey(at(2026, 0, 5, 23, 59))).toBe('2026-01-05')
  })

  it('startOfWeek honours the first weekday', () => {
    const wed = at(2026, 9, 14, 12)
    expect(dayKey(startOfWeek(wed, 1))).toBe('2026-10-12') // Monday start
    expect(dayKey(startOfWeek(wed, 0))).toBe('2026-10-11') // Sunday start
    expect(dayKey(startOfWeek(MON, 1))).toBe('2026-10-12') // already the first day
  })

  it('startOfMonth is the 1st at midnight', () => {
    expect(dayKey(startOfMonth(at(2026, 1, 28, 8)))).toBe('2026-02-01')
  })

  it('localeWeekStart reads Intl week info, else the region, else Monday', () => {
    expect(localeWeekStart('en-US')).toBe(0)
    expect(localeWeekStart('en-GB')).toBe(1)
    expect(localeWeekStart('not a locale tag!')).toBe(1)
  })

  it('localeWeekend is the locale’s weekend, else Saturday and Sunday', () => {
    expect([...localeWeekend('en-US')].sort()).toEqual([0, 6])
    expect([...localeWeekend('not a locale tag!')].sort()).toEqual([0, 6])
  })
})

describe('pickShown', () => {
  const items = ['a', 'b', 'c', 'd', 'e'].map((id) => ({ id }))
  const ids = (list: { id: string }[]) => list.map((x) => x.id)

  it('keeps everything under the cap', () => {
    expect(ids(pickShown(items.slice(0, 2), 3, new Set()))).toEqual(['a', 'b'])
  })

  it('shows the newest, in order', () => {
    expect(ids(pickShown(items, 3, new Set()))).toEqual(['c', 'd', 'e'])
  })

  it('keeps a pinned item in sight, counting it toward the cap', () => {
    expect(ids(pickShown(items, 3, new Set(['a'])))).toEqual(['a', 'd', 'e'])
  })
})

describe('buildRange', () => {
  it('a week is seven consecutive days ending at the next midnight', () => {
    const r = buildRange('week', at(2026, 9, 15, 10), 1)
    expect(r.days.map(dayKey)).toEqual([
      '2026-10-12',
      '2026-10-13',
      '2026-10-14',
      '2026-10-15',
      '2026-10-16',
      '2026-10-17',
      '2026-10-18',
    ])
    expect(r.start).toBe(r.days[0])
    expect(dayKey(r.end)).toBe('2026-10-19')
    expect(rangeBounds(r)).toEqual([...r.days, r.end])
  })

  it('a month is every day of that month', () => {
    expect(buildRange('month', at(2026, 1, 10), 1).days).toHaveLength(28)
    expect(buildRange('month', at(2028, 1, 10), 1).days).toHaveLength(29)
    const oct = buildRange('month', at(2026, 9, 31, 23), 1)
    expect(oct.days).toHaveLength(31)
    expect(dayKey(oct.end)).toBe('2026-11-01')
  })

  it('a day is that one day, ending at the next midnight', () => {
    const r = buildRange('day', at(2026, 9, 15, 23), 1)
    expect(r.mode).toBe('day')
    expect(r.days.map(dayKey)).toEqual(['2026-10-15'])
    expect(r.start).toBe(r.days[0])
    expect(dayKey(r.end)).toBe('2026-10-16')
    expect(rangeBounds(r)).toEqual([r.start, r.end])
  })

  it('shiftFocus moves by a day, a week or a calendar month', () => {
    expect(dayKey(shiftFocus('day', MON, 1))).toBe('2026-10-13')
    expect(dayKey(shiftFocus('day', MON, -1))).toBe('2026-10-11')
    expect(dayKey(shiftFocus('week', MON, 1))).toBe('2026-10-19')
    expect(dayKey(shiftFocus('week', MON, -1))).toBe('2026-10-05')
    // From the 31st the month still steps by one, never skipping a short month.
    expect(dayKey(shiftFocus('month', at(2026, 0, 31), 1))).toBe('2026-02-01')
    expect(dayKey(shiftFocus('month', at(2026, 0, 31), -1))).toBe('2025-12-01')
  })
})

describe('task placement', () => {
  const created = at(2026, 9, 12, 9)
  const updated = at(2026, 9, 14, 11)
  const finished = at(2026, 9, 15, 16)

  it('open work sits on the day it was added, wherever it is in its lifecycle', () => {
    for (const status of ['backlog', 'todo', 'in_progress', 'in_review', 'blocked']) {
      expect(taskAnchor({ status, createdAt: created, updatedAt: updated }, 0)).toBe(created)
    }
  })

  it('finished work sits on the day it finished', () => {
    const task = { createdAt: created, updatedAt: updated, completedAt: finished }
    expect(taskAnchor({ ...task, status: 'done' }, 0)).toBe(finished)
    expect(taskAnchor({ ...task, status: 'cancelled' }, 0)).toBe(finished)
    expect(taskAnchor({ status: 'done', createdAt: created, updatedAt: updated }, 0)).toBe(updated)
  })

  it('a row with no usable timestamps shows on now, not nowhere', () => {
    const now = at(2026, 9, 13, 8)
    expect(taskAnchor({ status: 'todo' }, now)).toBe(now)
    expect(taskAnchor({ status: 'done', completedAt: 'x', createdAt: -5 }, now)).toBe(now)
  })

  it('landingAnchor: a finishing move lands today, any other move keeps its day', () => {
    const now = at(2026, 9, 16, 10)
    const task = { status: 'todo', createdAt: created }
    expect(landingAnchor(task, 'done', now)).toBe(now)
    expect(landingAnchor(task, 'cancelled', now)).toBe(now)
    expect(landingAnchor(task, 'in_progress', now)).toBe(created)
  })

  it('buckets by column and day, in time order, and collects earlier open work', () => {
    const range = buildRange('week', MON, 1)
    const now = at(2026, 9, 16, 12)
    const tasks = [
      { id: 'late', status: 'todo', createdAt: at(2026, 9, 13, 18) },
      { id: 'early', status: 'todo', createdAt: at(2026, 9, 13, 7) },
      { id: 'done', status: 'done', createdAt: at(2026, 9, 1), completedAt: at(2026, 9, 14, 9) },
      { id: 'stale', status: 'backlog', createdAt: at(2026, 8, 2) },
      { id: 'old-done', status: 'done', createdAt: at(2026, 8, 2), completedAt: at(2026, 8, 3) },
      { id: 'next-week', status: 'todo', createdAt: at(2026, 9, 20) },
    ]
    const { cells, earlier } = bucketTasks(tasks, range, now, (t) => t.status)
    expect(
      cells
        .get('todo')
        ?.get('2026-10-13')
        ?.map((t) => t.id),
    ).toEqual(['early', 'late'])
    expect(
      cells
        .get('done')
        ?.get('2026-10-14')
        ?.map((t) => t.id),
    ).toEqual(['done'])
    expect(earlier.get('backlog')?.map((t) => t.id)).toEqual(['stale'])
    // Finished history before the range, and anything after it, are left out.
    const all = [...cells.values()].flatMap((m) => [...m.values()].flat()).map((t) => t.id)
    expect(all).not.toContain('old-done')
    expect(all).not.toContain('next-week')
    expect(earlier.get('done')).toBeUndefined()
  })
})

describe('bucketRuns', () => {
  it('indexes each routine’s runs by day, earliest first', () => {
    const range = buildRange('week', MON, 1)
    const empty = { count: 0, more: false, times: [] as number[] }
    const windows = (dayIndex: number, hour: number) =>
      range.days.map((d, i) =>
        i === dayIndex ? { count: 1, more: false, times: [d + hour * 3_600_000] } : empty,
      )
    const runs = bucketRuns(
      [
        { routine: 'evening', windows: windows(2, 18) },
        { routine: 'morning', windows: windows(2, 9) },
      ],
      range,
    )
    expect(runs.get('2026-10-14')?.map((r) => r.routine)).toEqual(['morning', 'evening'])
    expect(runs.size).toBe(1)
  })

  it('skips a response whose windows do not line up with the range', () => {
    const range = buildRange('week', MON, 1)
    const runs = bucketRuns(
      [{ routine: 'x', windows: [{ count: 1, more: false, times: [range.start + 1] }] }],
      range,
    )
    expect(runs.size).toBe(0)
  })
})

describe('bucketAll', () => {
  it('puts every task in one row per column, newest first, finished work included', () => {
    const now = at(2026, 9, 14, 12)
    const tasks = [
      { id: 'a', status: 'todo', createdAt: at(2026, 8, 1) },
      { id: 'b', status: 'todo', createdAt: at(2026, 9, 14, 9) },
      { id: 'c', status: 'done', createdAt: at(2026, 0, 1), completedAt: at(2026, 9, 1) },
      { id: 'd', status: 'todo' },
    ]
    const { cells, earlier } = bucketAll(tasks, now, (t) => t.status)
    expect(earlier.size).toBe(0)
    // A task with no timestamp is placed at now, so it reads as the newest.
    expect(
      cells
        .get('todo')
        ?.get(ALL_ROW)
        ?.map((t) => t.id),
    ).toEqual(['d', 'b', 'a'])
    expect(
      cells
        .get('done')
        ?.get(ALL_ROW)
        ?.map((t) => t.id),
    ).toEqual(['c'])
  })
})
