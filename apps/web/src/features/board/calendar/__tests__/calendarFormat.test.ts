import { describe, expect, it } from 'vitest'

import {
  countLabel,
  elapsedLabel,
  isoWeek,
  rangeRelation,
  rangeTitle,
  relativeDayWord,
  sinceLabel,
  timeLabel,
  timeOnDay,
  weekdayShort,
} from '../calendarFormat'
import { addDays, buildRange } from '../calendarModel'

const at = (y: number, mo: number, d: number, h = 0): number => new Date(y, mo, d, h).getTime()

// The day and month come in the viewer's locale order ("Oct 12" in the US, "12 Oct"
// in India), so these build their expectation with the same formatter.
const md = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { month: 'short', day: 'numeric' })

describe('rangeTitle', () => {
  it('collapses a single-month week to one month name, with the year apart', () => {
    const t = rangeTitle(buildRange('week', at(2026, 9, 14), 1))
    expect(t.year).toBe('2026')
    expect(t.dates).toBe(`${md(at(2026, 9, 12))} to 18`)
  })

  it('names both months for a week that crosses one', () => {
    const t = rangeTitle(buildRange('week', at(2026, 9, 1), 1))
    expect(t.dates).toBe(`${md(at(2026, 8, 28))} to ${md(at(2026, 9, 4))}`)
  })

  it('names both years for a week that crosses one, with no separate year', () => {
    const t = rangeTitle(buildRange('week', at(2026, 11, 30), 1))
    expect(t.dates).toMatch(/2026 to .*2027/)
    expect(t.year).toBe('')
  })

  it('a day view is the weekday and date, with the year apart', () => {
    const day = at(2026, 9, 14)
    expect(rangeTitle(buildRange('day', day, 1))).toEqual({
      dates: new Date(day).toLocaleDateString(undefined, {
        weekday: 'long',
        month: 'short',
        day: 'numeric',
      }),
      year: '2026',
    })
  })

  it('a month view is the month and its year', () => {
    expect(rangeTitle(buildRange('month', at(2026, 9, 14), 1))).toEqual({
      dates: 'October',
      year: '2026',
    })
  })

  it('never uses a dash between the ends', () => {
    for (const focus of [at(2026, 9, 14), at(2026, 9, 1), at(2026, 11, 30)]) {
      expect(rangeTitle(buildRange('week', focus, 1)).dates).not.toMatch(/[–—-]/)
    }
  })
})

describe('rangeRelation', () => {
  const now = at(2026, 9, 14, 10) // a Wednesday
  it('names the week holding now and its neighbours', () => {
    expect(rangeRelation(buildRange('week', now, 1), now)).toBe('This week')
    expect(rangeRelation(buildRange('week', addDays(now, 7), 1), now)).toBe('Next week')
    expect(rangeRelation(buildRange('week', addDays(now, -7), 1), now)).toBe('Last week')
    expect(rangeRelation(buildRange('week', addDays(now, 21), 1), now)).toBeNull()
  })

  it('works for a Sunday-start week too', () => {
    expect(rangeRelation(buildRange('week', now, 0), now)).toBe('This week')
    expect(rangeRelation(buildRange('week', addDays(now, 7), 0), now)).toBe('Next week')
  })

  it('names the month holding now and its neighbours', () => {
    expect(rangeRelation(buildRange('month', now, 1), now)).toBe('This month')
    expect(rangeRelation(buildRange('month', at(2026, 10, 3), 1), now)).toBe('Next month')
    expect(rangeRelation(buildRange('month', at(2026, 8, 3), 1), now)).toBe('Last month')
    expect(rangeRelation(buildRange('month', at(2027, 0, 3), 1), now)).toBeNull()
  })
})

describe('relativeDayWord', () => {
  it('names today, tomorrow and yesterday only', () => {
    const now = at(2026, 9, 14, 15)
    expect(relativeDayWord(at(2026, 9, 14), now)).toBe('Today')
    expect(relativeDayWord(at(2026, 9, 15), now)).toBe('Tomorrow')
    expect(relativeDayWord(at(2026, 9, 13), now)).toBe('Yesterday')
    expect(relativeDayWord(at(2026, 9, 16), now)).toBeNull()
  })
})

describe('isoWeek', () => {
  it('matches ISO 8601 week numbers, including the year edges', () => {
    expect(isoWeek(at(2026, 9, 12))).toBe(42)
    expect(isoWeek(at(2026, 0, 1))).toBe(1) // Thursday Jan 1 2026
    expect(isoWeek(at(2027, 0, 1))).toBe(53) // Friday Jan 1 2027 belongs to 2026-W53
    expect(isoWeek(at(2024, 11, 30))).toBe(1) // Monday Dec 30 2024 is 2025-W01
  })
})

describe('countLabel', () => {
  it('pluralises', () => {
    expect(countLabel(1, 'task')).toBe('1 task')
    expect(countLabel(3, 'task')).toBe('3 tasks')
    expect(countLabel(2, 'run')).toBe('2 runs')
  })
})

describe('rangeRelation for a day', () => {
  const now = at(2026, 9, 14, 10)
  it('names today and its neighbours, and nothing further out', () => {
    expect(rangeRelation(buildRange('day', now, 1), now)).toBe('Today')
    expect(rangeRelation(buildRange('day', addDays(now, 1), 1), now)).toBe('Tomorrow')
    expect(rangeRelation(buildRange('day', addDays(now, -1), 1), now)).toBe('Yesterday')
    expect(rangeRelation(buildRange('day', addDays(now, 3), 1), now)).toBeNull()
  })
})

describe('elapsedLabel', () => {
  const MIN = 60_000
  it('reads under a minute, minutes, hours and days the way a card has room for', () => {
    expect(elapsedLabel(0)).toBe('<1m')
    expect(elapsedLabel(59_999)).toBe('<1m')
    expect(elapsedLabel(MIN)).toBe('1m')
    expect(elapsedLabel(59 * MIN)).toBe('59m')
    expect(elapsedLabel(60 * MIN)).toBe('1h')
    expect(elapsedLabel(125 * MIN)).toBe('2h 5m')
    expect(elapsedLabel(24 * 60 * MIN)).toBe('1d')
    expect(elapsedLabel((4 * 24 + 2) * 60 * MIN + 30 * MIN)).toBe('4d 2h')
  })

  it('reads a start in the future as just begun', () => {
    expect(elapsedLabel(-5 * MIN)).toBe('<1m')
  })
})

describe('timeOnDay and sinceLabel', () => {
  const now = at(2026, 9, 14, 15)
  it('gives the time alone today and the day with it otherwise', () => {
    const today = at(2026, 9, 14, 9)
    const monday = at(2026, 9, 12, 9)
    expect(timeOnDay(today, now)).toBe(timeLabel(today))
    expect(timeOnDay(monday, now)).toContain(timeLabel(monday))
    expect(timeOnDay(monday, now)).not.toBe(timeLabel(monday))
  })

  it('says when the person last caught up in as few words as it can', () => {
    const today = at(2026, 9, 14, 9)
    const yesterday = at(2026, 9, 13, 16)
    const thisWeek = at(2026, 9, 10, 8)
    const longAgo = at(2026, 8, 20, 8)
    expect(sinceLabel(today, now)).toBe(timeLabel(today))
    expect(sinceLabel(yesterday, now)).toBe(`yesterday ${timeLabel(yesterday)}`)
    expect(sinceLabel(thisWeek, now)).toBe(`${weekdayShort(thisWeek)} ${timeLabel(thisWeek)}`)
    expect(sinceLabel(longAgo, now)).toBe(md(longAgo))
  })
})
