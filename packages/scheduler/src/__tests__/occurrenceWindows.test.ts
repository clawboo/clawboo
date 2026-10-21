import { describe, expect, it } from 'vitest'

import { InvalidCronSpecError } from '../errors'
import { nextOccurrence, occurrencesInWindows } from '../occurrence'

// Whole-hour anchors in UTC. Every assertion below is either built from
// nextOccurrence itself or uses an every-minute spec, so the results hold in any
// time zone the suite runs in (croner evaluates cron in the process's zone).
const HOUR = 3_600_000
const MIN = 60_000
const T0 = Date.parse('2026-06-10T00:00:00.000Z')
const day = (n: number): number => T0 + n * 24 * HOUR

describe('occurrencesInWindows', () => {
  it('returns one entry per window, in order', () => {
    const out = occurrencesInWindows('0 9 * * *', [day(0), day(1), day(2), day(3)], { after: 0 })
    expect(out).toHaveLength(3)
  })

  it('matches nextOccurrence run for run', () => {
    const bounds = [day(0), day(1), day(2)]
    const out = occurrencesInWindows('0 */6 * * *', bounds, { after: 0 })
    const expected: number[] = []
    for (let t = nextOccurrence('0 */6 * * *', day(0) - 1); t != null && t < day(2);) {
      expected.push(t)
      t = nextOccurrence('0 */6 * * *', t)
    }
    expect(out.flatMap((w) => w.times)).toEqual(expected)
    expect(out.reduce((n, w) => n + w.count, 0)).toBe(expected.length)
    expect(out.every((w) => !w.more)).toBe(true)
  })

  it('keeps a run that lands exactly on a window edge, in the window it opens', () => {
    const first = nextOccurrence('* * * * *', T0)!
    const out = occurrencesInWindows('* * * * *', [first, first + MIN, first + 2 * MIN], {
      after: 0,
    })
    expect(out[0]!.times).toEqual([first])
    expect(out[1]!.times).toEqual([first + MIN])
  })

  it('only counts runs strictly after `after`', () => {
    const start = nextOccurrence('* * * * *', T0)!
    const out = occurrencesInWindows('* * * * *', [start, start + 10 * MIN], {
      after: start + 4 * MIN,
    })
    expect(out[0]!.times[0]).toBe(start + 5 * MIN)
    expect(out[0]!.count).toBe(5)
  })

  it('a window wholly before `after` is empty', () => {
    const out = occurrencesInWindows('* * * * *', [day(0), day(1), day(2)], { after: day(1) })
    expect(out[0]).toEqual({ count: 0, more: false, times: [] })
    expect(out[1]!.count).toBeGreaterThan(0)
  })

  it('caps the count per window and marks the rest as more', () => {
    const out = occurrencesInWindows('* * * * *', [day(0), day(1), day(2)], {
      after: 0,
      countCap: 10,
      timesCap: 3,
    })
    for (const w of out) {
      expect(w.count).toBe(10)
      expect(w.more).toBe(true)
      expect(w.times).toHaveLength(3)
    }
  })

  it('a cap that is exactly reached is not more', () => {
    const start = nextOccurrence('* * * * *', T0)!
    const out = occurrencesInWindows('* * * * *', [start, start + 5 * MIN], {
      after: 0,
      countCap: 5,
    })
    expect(out[0]).toMatchObject({ count: 5, more: false })
  })

  it('projects a future once@ into its window, and a past one nowhere', () => {
    const at = day(1) + 9 * HOUR
    const spec = `once@${new Date(at).toISOString()}`
    const out = occurrencesInWindows(spec, [day(0), day(1), day(2)], { after: day(0) })
    expect(out[0]!.count).toBe(0)
    expect(out[1]).toEqual({ count: 1, more: false, times: [at] })
    const past = occurrencesInWindows(spec, [day(0), day(1), day(2)], { after: day(3) })
    expect(past.every((w) => w.count === 0)).toBe(true)
  })

  it('throws a typed error on a malformed spec', () => {
    expect(() => occurrencesInWindows('not a cron', [day(0), day(1)], { after: 0 })).toThrow(
      InvalidCronSpecError,
    )
  })

  it('rejects bounds that are too short, unordered, or not finite', () => {
    expect(() => occurrencesInWindows('* * * * *', [day(0)], { after: 0 })).toThrow(RangeError)
    expect(() => occurrencesInWindows('* * * * *', [day(1), day(0)], { after: 0 })).toThrow(
      RangeError,
    )
    expect(() => occurrencesInWindows('* * * * *', [day(0), day(0)], { after: 0 })).toThrow(
      RangeError,
    )
    expect(() => occurrencesInWindows('* * * * *', [day(0), Number.NaN], { after: 0 })).toThrow(
      RangeError,
    )
  })

  it('counts a known first run, then follows the spec from it', () => {
    const start = nextOccurrence('0 9 * * *', day(0) - 1)!
    // A stored next run that the spec would not produce (an edit mid-fire).
    const stored = start + 30 * MIN
    const out = occurrencesInWindows('0 9 * * *', [day(0), day(1), day(2), day(3)], {
      after: 0,
      first: stored,
    })
    const times = out.flatMap((w) => w.times)
    expect(times[0]).toBe(stored)
    expect(times[1]).toBe(nextOccurrence('0 9 * * *', stored))
    expect(times).not.toContain(start)
  })

  it('ignores a first run that is not after `after`, and one past the windows', () => {
    const bounds = [day(0), day(1), day(2)]
    const plain = occurrencesInWindows('0 9 * * *', bounds, { after: 0 })
    expect(occurrencesInWindows('0 9 * * *', bounds, { after: day(5), first: day(4) })).toEqual(
      occurrencesInWindows('0 9 * * *', bounds, { after: day(5) }),
    )
    const late = occurrencesInWindows('0 9 * * *', bounds, { after: 0, first: day(4) })
    expect(late.every((w) => w.count === 0)).toBe(true)
    expect(plain.some((w) => w.count > 0)).toBe(true)
  })

  it('a first run before the windows hands over to the spec at it', () => {
    const bounds = [day(2), day(3)]
    const out = occurrencesInWindows('0 9 * * *', bounds, { after: 0, first: day(1) + 9 * HOUR })
    expect(out[0]!.times).toEqual([nextOccurrence('0 9 * * *', day(2) - 1)])
  })
})
