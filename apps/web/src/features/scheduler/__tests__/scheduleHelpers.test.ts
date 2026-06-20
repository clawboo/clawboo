// Pure scheduler display/intent helpers.

import { describe, expect, it } from 'vitest'

import { canScheduleOwnLife, formatScheduleLabel } from '../scheduleHelpers'

describe('formatScheduleLabel', () => {
  it('renders a routine one-shot (once@<iso>) as a friendly label, not the raw spec', () => {
    expect(formatScheduleLabel('once@2026-07-01T09:00:00.000Z')).toBe(
      'once · 2026-07-01T09:00:00.000Z',
    )
    // No leading "once@" prefix leaks into the rendered label.
    expect(formatScheduleLabel('once@2026-07-01T09:00:00.000Z')).not.toContain('once@')
  })

  it('falls back to the raw spec for a malformed once@ timestamp', () => {
    expect(formatScheduleLabel('once@not-a-date')).toBe('once@not-a-date')
  })

  it('keeps the existing gateway dialects working', () => {
    expect(formatScheduleLabel('every:3600000')).toBe('every 1h')
    expect(formatScheduleLabel('every:300000')).toBe('every 5m')
    expect(formatScheduleLabel('at:2026-07-01T09:00:00.000Z')).toBe(
      'once · 2026-07-01T09:00:00.000Z',
    )
    expect(formatScheduleLabel('*/15 * * * *')).toBe('*/15 * * * *')
  })
})

describe('canScheduleOwnLife', () => {
  it('only an OpenClaw runtime may be scheduled for its own life (Gateway cron)', () => {
    expect(canScheduleOwnLife('openclaw')).toBe(true)
    expect(canScheduleOwnLife('clawboo-native')).toBe(false)
    expect(canScheduleOwnLife('claude-code')).toBe(false)
    expect(canScheduleOwnLife('')).toBe(false)
    expect(canScheduleOwnLife(undefined)).toBe(false)
    expect(canScheduleOwnLife(null)).toBe(false)
  })
})
