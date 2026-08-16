// The ONE verification budget.
//
// There used to be two and they disagreed: this module defaulted to the
// governance package's `DEFAULT_MAX_FIX_CYCLES = 3` while the executor's
// re-dispatch loop defaulted to `1`. Attempts therefore topped out at 2, the
// inner policy's `mark_debt` exit (which only fires AT exhaustion) was
// unreachable, and a failing task parked `in_progress` — a status the board reads
// as "someone is working on this" when nobody is.
//
// The env var counts FIX CYCLES; this returns total ATTEMPTS, which is one more.

import { afterEach, describe, expect, it } from 'vitest'

import { verifyMaxAttempts } from '../index'

const KEY = 'CLAWBOO_MAX_FIX_CYCLES'

afterEach(() => {
  delete process.env[KEY]
})

describe('verifyMaxAttempts', () => {
  it('defaults to 2 attempts: the initial run plus one fix cycle', () => {
    delete process.env[KEY]
    expect(verifyMaxAttempts()).toBe(2)
  })

  it('0 cycles means a single attempt (the fix loop is off, not infinite)', () => {
    process.env[KEY] = '0'
    expect(verifyMaxAttempts()).toBe(1)
  })

  it('3 cycles means 4 attempts', () => {
    process.env[KEY] = '3'
    expect(verifyMaxAttempts()).toBe(4)
  })

  it('an unparseable value falls back to the default, never NaN', () => {
    // `Number('abc') || 1` was the old idiom; a NaN budget compared with `>=`
    // is always false, which would make exhaustion unreachable all over again.
    process.env[KEY] = 'abc'
    expect(verifyMaxAttempts()).toBe(2)
    process.env[KEY] = ''
    expect(verifyMaxAttempts()).toBe(2)
    process.env[KEY] = '-4'
    expect(verifyMaxAttempts()).toBe(2)
  })

  it('a fractional value floors rather than producing a fractional budget', () => {
    process.env[KEY] = '2.9'
    expect(verifyMaxAttempts()).toBe(3)
  })
})
