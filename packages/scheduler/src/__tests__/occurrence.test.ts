import { describe, expect, it } from 'vitest'

import { InvalidCronSpecError } from '../errors'
import { nextOccurrence, probeCronSpec } from '../occurrence'

const T0 = Date.parse('2026-06-10T12:30:00.000Z')

describe('nextOccurrence', () => {
  it('is deterministic for a fixed from anchor', () => {
    const a = nextOccurrence('0 9 * * *', T0)
    const b = nextOccurrence('0 9 * * *', T0)
    expect(a).toBe(b)
    expect(a).not.toBeNull()
    expect(a!).toBeGreaterThan(T0)
  })

  it('returns the next occurrence STRICTLY after from', () => {
    // An every-minute expression anchored exactly on a minute boundary must
    // not return the boundary itself.
    const onMinute = Date.parse('2026-06-10T12:30:00.000Z')
    const next = nextOccurrence('* * * * *', onMinute)
    expect(next).not.toBeNull()
    expect(next!).toBeGreaterThan(onMinute)
  })

  it('once@ in the future returns its timestamp; in the past returns null', () => {
    const future = Date.parse('2026-07-01T09:00:00.000Z')
    expect(nextOccurrence('once@2026-07-01T09:00:00.000Z', T0)).toBe(future)
    expect(nextOccurrence('once@2020-01-01T00:00:00.000Z', T0)).toBeNull()
  })

  it('throws typed errors on malformed expressions', () => {
    expect(() => nextOccurrence('not a cron', T0)).toThrow(InvalidCronSpecError)
    expect(() => probeCronSpec('99 99 99 99 99')).toThrow(InvalidCronSpecError)
  })

  it('probeCronSpec accepts valid specs', () => {
    expect(() => probeCronSpec('*/5 * * * *')).not.toThrow()
    expect(() => probeCronSpec('once@2026-07-01T09:00:00Z')).not.toThrow()
  })
})

/** The wall-clock hour and minute of `ms` in `timeZone`. */
function clockIn(timeZone: string, ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ms)
}

describe('nextOccurrence in a named time zone', () => {
  // Fourteen hours ahead of UTC and eleven behind it: their 09:00 instants are
  // a day and an hour apart, so whatever zone the suite runs in, at most one of
  // them can match it, and evaluating in the process zone fails the other.
  const ZONES = ['Pacific/Kiritimati', 'Pacific/Pago_Pago']

  it('fires at the wall-clock time in that zone, not the process zone', () => {
    for (const zone of ZONES) {
      const next = nextOccurrence('0 9 * * *', T0, zone)
      expect(next, zone).not.toBeNull()
      expect(clockIn(zone, next!), zone).toBe('09:00')
      expect(next!, zone).toBeGreaterThan(T0)
      expect(next! - T0, zone).toBeLessThanOrEqual(24 * 3_600_000)
    }
  })

  it('leaves a once@ instant where it is', () => {
    const at = Date.parse('2026-07-01T09:00:00.000Z')
    expect(nextOccurrence('once@2026-07-01T09:00:00.000Z', T0, 'Pacific/Kiritimati')).toBe(at)
  })

  it('without a zone, evaluates in the process zone as before', () => {
    const local = nextOccurrence('0 9 * * *', T0)!
    expect(new Date(local).getHours()).toBe(9)
  })

  it('probeCronSpec takes the zone too', () => {
    expect(() => probeCronSpec('0 9 * * *', 'Pacific/Kiritimati')).not.toThrow()
  })
})
