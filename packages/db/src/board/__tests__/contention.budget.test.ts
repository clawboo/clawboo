// Deterministic guard on the write-retry BUDGET. No real contention, no real
// sleeping, no fake timers — `sleepSync` blocks on `Atomics.wait`, which a mocked
// clock cannot advance, so the budget is driven through the injected clock/sleep
// seam: a virtual clock that only the fake `sleep` moves. This runs in the DEFAULT
// `pnpm test`, unlike the real-OS-thread board.contention.test.ts, which needs the
// built dist and is gated behind CLAWBOO_CONCURRENCY_TEST=1.
//
// The property under guard: because the retry sleep blocks the server's event
// loop, one contended write must not be able to freeze the process for more than
// the budget. An attempt COUNT cannot express that; a deadline can.

import { afterEach, describe, expect, it } from 'vitest'

import { isBusyError, withWriteRetry, WriteBudgetExhaustedError } from '../contention'

/** A synthetic SQLite lock error — the shape `isBusyError` recognises. */
function busy(code = 'SQLITE_BUSY'): Error {
  return Object.assign(new Error('database is locked'), { code })
}

/** A clock that ONLY the fake sleep advances, so elapsed time is exact. */
function virtualClock(): { now: () => number; sleep: (ms: number) => void; elapsed: () => number } {
  let t = 0
  return { now: () => t, sleep: (ms: number) => void (t += ms), elapsed: () => t }
}

const BUDGET = 1500
const CAP = 24

describe('withWriteRetry — wall-clock budget', () => {
  it('gives up at the DEADLINE, not at the attempt cap, and never overshoots it', () => {
    // The budget is deliberately small relative to `attemptCap × JITTER_MIN` (24 × 20
    // = 480ms): the deadline is then the ONLY thing that can stop this loop, so the
    // assertions below fail if the wall-clock check is ever removed and the cap is
    // left to terminate it. A budget near cap×jitter would not discriminate — the
    // cap alone throws the same error, and the elapsed bound would straddle it.
    const SMALL_BUDGET = 300
    const clock = virtualClock()
    let attempts = 0

    const run = (): never =>
      withWriteRetry(
        () => {
          attempts += 1
          throw busy()
        },
        { budgetMs: SMALL_BUDGET, attemptCap: CAP, now: clock.now, sleep: clock.sleep },
      )

    expect(run).toThrow(WriteBudgetExhaustedError)
    // The final sleep is clamped to the remaining budget, so the loop stops AT the
    // deadline rather than a whole jitter interval past it.
    expect(clock.elapsed()).toBeLessThanOrEqual(SMALL_BUDGET)
    expect(attempts).toBeGreaterThan(1)
    // Strictly BELOW the cap — proving the deadline bound the loop, not the cap.
    // Worst case is ⌈300/20⌉ + 1 = 16 attempts, comfortably under 24.
    expect(attempts).toBeLessThan(CAP)
  })

  it('the deadline still binds when the attempt cap is effectively unlimited', () => {
    // Same property from the other side: with no usable cap, only the wall clock can
    // terminate this. If the deadline check is removed, this hangs to the cap instead.
    const clock = virtualClock()
    let attempts = 0

    expect(() =>
      withWriteRetry(
        () => {
          attempts += 1
          throw busy()
        },
        { budgetMs: BUDGET, attemptCap: 10_000, now: clock.now, sleep: clock.sleep },
      ),
    ).toThrow(WriteBudgetExhaustedError)

    expect(clock.elapsed()).toBeLessThanOrEqual(BUDGET)
    expect(attempts).toBeLessThan(10_000)
  })

  it('the exhaustion error stays a busy error and keeps the original as its cause', () => {
    const clock = virtualClock()
    const original = busy()
    let caught: unknown
    try {
      withWriteRetry(
        () => {
          throw original
        },
        { budgetMs: BUDGET, now: clock.now, sleep: clock.sleep },
      )
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(WriteBudgetExhaustedError)
    // Load-bearing: callers that already branch on isBusyError must not change.
    expect(isBusyError(caught)).toBe(true)
    const err = caught as WriteBudgetExhaustedError
    expect(err.cause).toBe(original)
    expect(err.budgetMs).toBe(BUDGET)
    expect(err.attempts).toBeGreaterThan(1)
    expect(err.message).toContain(`budget ${BUDGET}ms`)
  })

  it('returns as soon as the write succeeds, spending only the sleeps it needed', () => {
    const clock = virtualClock()
    let attempts = 0

    const value = withWriteRetry(
      () => {
        attempts += 1
        if (attempts <= 2) throw busy()
        return 'written'
      },
      { budgetMs: BUDGET, now: clock.now, sleep: clock.sleep },
    )

    expect(value).toBe('written')
    expect(attempts).toBe(3)
    // Two sleeps, jitter capped at 150ms each.
    expect(clock.elapsed()).toBeLessThanOrEqual(300)
  })

  it('propagates a non-lock error immediately, unwrapped, without sleeping', () => {
    const clock = virtualClock()
    const fatal = Object.assign(new Error('UNIQUE constraint failed'), {
      code: 'SQLITE_CONSTRAINT',
    })
    let attempts = 0

    expect(() =>
      withWriteRetry(
        () => {
          attempts += 1
          throw fatal
        },
        { budgetMs: BUDGET, now: clock.now, sleep: clock.sleep },
      ),
    ).toThrow(fatal)

    expect(attempts).toBe(1)
    expect(clock.elapsed()).toBe(0)
  })

  it.each(['SQLITE_BUSY', 'SQLITE_BUSY_SNAPSHOT', 'SQLITE_LOCKED'])('retries %s', (code) => {
    const clock = virtualClock()
    let attempts = 0

    const value = withWriteRetry(
      () => {
        attempts += 1
        if (attempts === 1) throw busy(code)
        return code
      },
      { budgetMs: BUDGET, now: clock.now, sleep: clock.sleep },
    )

    expect(value).toBe(code)
    expect(attempts).toBe(2)
  })

  it('does NOT retry an error with no SQLite code', () => {
    const clock = virtualClock()
    let attempts = 0

    expect(() =>
      withWriteRetry(
        () => {
          attempts += 1
          throw new Error('database is locked') // message alone must not qualify
        },
        { budgetMs: BUDGET, now: clock.now, sleep: clock.sleep },
      ),
    ).toThrow('database is locked')

    expect(attempts).toBe(1)
  })

  it('terminates on the attempt backstop when the clock never advances', () => {
    // SQLITE_BUSY_SNAPSHOT is returned WITHOUT invoking SQLite's busy handler, so
    // in the worst case a cycle costs almost nothing. The cap is what makes that
    // loop terminate; the deadline alone would not.
    let attempts = 0

    expect(() =>
      withWriteRetry(
        () => {
          attempts += 1
          throw busy('SQLITE_BUSY_SNAPSHOT')
        },
        { budgetMs: 60_000, attemptCap: CAP, now: () => 0, sleep: () => {} },
      ),
    ).toThrow(WriteBudgetExhaustedError)

    expect(attempts).toBe(CAP)
  })
})

describe('withWriteRetry — the real clock and sleep', () => {
  const prev = process.env['CLAWBOO_DB_WRITE_BUDGET_MS']
  afterEach(() => {
    if (prev === undefined) delete process.env['CLAWBOO_DB_WRITE_BUDGET_MS']
    else process.env['CLAWBOO_DB_WRITE_BUDGET_MS'] = prev
  })

  it('honours CLAWBOO_DB_WRITE_BUDGET_MS on the production performance.now/sleepSync path', () => {
    // No injection here — this is the only case that exercises the real monotonic
    // clock and the real Atomics.wait sleep. A short budget keeps it fast.
    process.env['CLAWBOO_DB_WRITE_BUDGET_MS'] = '120'
    const startedAt = performance.now()
    let caught: unknown

    try {
      withWriteRetry(() => {
        throw busy()
      })
    } catch (err) {
      caught = err
    }

    expect(caught).toBeInstanceOf(WriteBudgetExhaustedError)
    expect((caught as WriteBudgetExhaustedError).budgetMs).toBe(120)
    // Generous upper bound: this asserts the budget is honoured at all, not a
    // timing threshold that would flake on a loaded CI runner.
    expect(performance.now() - startedAt).toBeLessThan(5_000)
  })
})
