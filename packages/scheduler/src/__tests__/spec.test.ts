import { describe, expect, it } from 'vitest'

import { InvalidCronSpecError } from '../errors'
import { isOnceSpec, parseCronSpec } from '../spec'

describe('parseCronSpec', () => {
  it('parses a once@ spec into epoch ms', () => {
    const atMs = Date.parse('2026-07-01T09:00:00.000Z')
    expect(parseCronSpec('once@2026-07-01T09:00:00.000Z')).toEqual({ kind: 'once', atMs })
  })

  it('treats anything else as a cron expression (trimmed)', () => {
    expect(parseCronSpec('  0 9 * * 1  ')).toEqual({ kind: 'cron', expr: '0 9 * * 1' })
  })

  it('throws typed errors on empty and malformed once@ specs', () => {
    expect(() => parseCronSpec('')).toThrow(InvalidCronSpecError)
    expect(() => parseCronSpec('once@not-a-date')).toThrow(InvalidCronSpecError)
    try {
      parseCronSpec('once@not-a-date')
    } catch (err) {
      expect((err as InvalidCronSpecError).code).toBe('invalid_cron_spec')
    }
  })

  it('isOnceSpec discriminates', () => {
    expect(isOnceSpec('once@2026-07-01T09:00:00Z')).toBe(true)
    expect(isOnceSpec('0 9 * * 1')).toBe(false)
  })
})
