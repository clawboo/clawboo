import { describe, expect, it } from 'vitest'

import { decodeCronSpec, encodeCronSpec, type GatewayCronScheduleShape } from '../records'

describe('gateway cronSpec codec', () => {
  const cases: GatewayCronScheduleShape[] = [
    { kind: 'cron', expr: '0 9 * * 1' },
    { kind: 'cron', expr: '0 9 * * 1', tz: 'America/New_York' },
    { kind: 'every', everyMs: 3_600_000 },
    { kind: 'every', everyMs: 3_600_000, anchorMs: 1_750_000_000_000 },
    { kind: 'at', at: '2026-07-01T09:00:00.000Z' },
  ]

  it.each(cases)('round-trips %j', (shape) => {
    expect(decodeCronSpec(encodeCronSpec(shape))).toEqual(shape)
  })

  it('treats an unprefixed spec as a bare cron expression', () => {
    expect(decodeCronSpec('*/15 * * * *')).toEqual({ kind: 'cron', expr: '*/15 * * * *' })
  })
})
