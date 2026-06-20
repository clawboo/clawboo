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
