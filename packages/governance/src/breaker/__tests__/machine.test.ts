import { describe, expect, it } from 'vitest'

import {
  BREAKER_DEFAULTS,
  createBreakerState,
  isPolicyDenialCode,
  stepBreaker,
  toolSignature,
  type BreakerConfig,
  type BreakerSignal,
  type BreakerTrip,
} from '../index'

/** Drive a signal sequence through a fresh machine; return the first trip + index. */
function feed(
  signals: BreakerSignal[],
  config: Partial<BreakerConfig> = {},
): { trip: BreakerTrip | null; firedAt: number } {
  const state = createBreakerState(config)
  let trip: BreakerTrip | null = null
  let firedAt = -1
  let i = 0
  for (const s of signals) {
    const t = stepBreaker(state, s)
    if (t) {
      trip = t
      firedAt = i
      break
    }
    i += 1
  }
  return { trip, firedAt }
}

const call = (signature: string, ts = 0): BreakerSignal => ({ kind: 'tool-call', signature, ts })
const result = (signature: string, ok: boolean, ts = 0): BreakerSignal => ({
  kind: 'tool-result',
  signature,
  ok,
  ts,
})
const cost = (tokens: number, ts: number): BreakerSignal => ({ kind: 'cost', tokens, ts })
const denied = (signature: string, ts = 0): BreakerSignal => ({
  kind: 'policy-denied',
  signature,
  ts,
})

describe('iteration cap', () => {
  it('trips when settled tool-calls exceed the cap', () => {
    const { trip, firedAt } = feed(
      Array.from({ length: 4 }, (_, i) => call(`t${i}`)),
      { maxToolIterations: 3 },
    )
    expect(trip?.reason).toBe('iteration-cap')
    expect(firedAt).toBe(3) // the 4th call (index 3) is the one over the cap
  })
  it('does not trip at exactly the cap', () => {
    expect(
      feed(
        Array.from({ length: 3 }, (_, i) => call(`t${i}`)),
        { maxToolIterations: 3 },
      ).trip,
    ).toBeNull()
  })
})

describe('repeat failure', () => {
  it('trips on N consecutive identical-tool failures', () => {
    const { trip, firedAt } = feed(
      [result('read', false), result('read', false), result('read', false)],
      {
        repeatFailureThreshold: 3,
      },
    )
    expect(trip?.reason).toBe('repeat-failure')
    expect(firedAt).toBe(2)
  })
  it('resets the streak when a different tool fails', () => {
    expect(
      feed([result('a', false), result('b', false), result('a', false)], {
        repeatFailureThreshold: 3,
      }).trip,
    ).toBeNull()
  })
  it('resets the streak on a success', () => {
    expect(
      feed(
        [
          result('read', false),
          result('read', false),
          result('other', true),
          result('read', false),
        ],
        {
          repeatFailureThreshold: 3,
        },
      ).trip,
    ).toBeNull()
  })
})

describe('no progress', () => {
  it('trips after N tool-results with no new successful output', () => {
    // 6 failures across alternating tools → repeat-failure never reaches 3, but
    // no-progress accrues to 6.
    const { trip, firedAt } = feed(
      Array.from({ length: 6 }, (_, i) => result(i % 2 ? 'b' : 'a', false)),
      BREAKER_DEFAULTS,
    )
    expect(trip?.reason).toBe('no-progress')
    expect(firedAt).toBe(5)
  })
  it('a new successful signature resets the counter', () => {
    const signals = [
      result('a', false),
      result('b', false),
      result('c', true), // productive → reset
      result('a', false),
      result('b', false),
    ]
    expect(feed(signals, { noProgressThreshold: 6, repeatFailureThreshold: 99 }).trip).toBeNull()
  })
  it('re-running the same successful tool is NEUTRAL (a healthy re-read never trips)', () => {
    // 1 productive (new 'read') + 6 SUCCESSFUL repeats of the same signature: a
    // legitimate re-read while reasoning. Successful repeats don't advance the
    // stall counter, so a healthy run is not false-aborted.
    const { trip } = feed(
      Array.from({ length: 7 }, () => result('read', true)),
      { noProgressThreshold: 6 },
    )
    expect(trip).toBeNull()
  })
  it('only FAILURES advance no-progress (a stuck loop still trips)', () => {
    // Even interleaved with successful re-reads, repeated failures accrue to the
    // threshold (different failing tools, so repeat-failure stays below 3).
    const signals = [
      result('read', true), // productive
      result('a', false),
      result('read', true), // neutral re-read
      result('b', false),
      result('read', true), // neutral re-read
      result('c', false),
      result('read', true), // neutral re-read
      result('d', false),
      result('read', true), // neutral re-read
      result('e', false),
      result('read', true), // neutral re-read
      result('f', false),
    ]
    expect(feed(signals, { noProgressThreshold: 6, repeatFailureThreshold: 99 }).trip?.reason).toBe(
      'no-progress',
    )
  })
})

describe('token velocity', () => {
  it('trips when tokens/min exceed the ceiling after the min window', () => {
    // 200k tokens over 20s = 600k/min > the 200k ceiling.
    expect(feed([cost(100_000, 0), cost(100_000, 20_000)], BREAKER_DEFAULTS).trip?.reason).toBe(
      'token-velocity',
    )
  })
  it('does not evaluate before the min window elapses', () => {
    // Huge tokens but only 1s elapsed → below velocityMinWindowMs → no trip.
    expect(feed([cost(1_000_000, 0), cost(1_000_000, 1_000)], BREAKER_DEFAULTS).trip).toBeNull()
  })
  it('does not divide by zero on same-timestamp cost events', () => {
    expect(
      feed([cost(1_000_000, 5), cost(1_000_000, 5)], {
        velocityMinWindowMs: 0,
        tokenVelocityCeiling: 1,
      }).trip,
    ).toBeNull()
  })
  it('a normal token rate never trips', () => {
    // 50k tokens over 60s = 50k/min < the 200k ceiling.
    expect(feed([cost(25_000, 0), cost(25_000, 60_000)], BREAKER_DEFAULTS).trip).toBeNull()
  })
  it('a SINGLE cost event never trips (the wrapped-oneshot limitation)', () => {
    // A wrapped-oneshot adapter (Claude Code / Codex / Hermes) emits exactly one
    // cost event per run, so elapsedMs is 0 and velocity cannot evaluate in-run —
    // even with an egregious token count. Reachable only on per-turn-cost (native)
    // runtimes or across rotations. Lock the documented limitation.
    expect(
      feed([cost(10_000_000, 0)], { velocityMinWindowMs: 15_000, tokenVelocityCeiling: 1 }).trip,
    ).toBeNull()
  })
})

describe('repeat policy-denied', () => {
  it('trips on N identical consecutive denials', () => {
    const { trip, firedAt } = feed([denied('write'), denied('write')], {
      repeatPolicyDeniedThreshold: 2,
    })
    expect(trip?.reason).toBe('repeat-policy-denied')
    expect(firedAt).toBe(1)
  })
  it('resets when the denied target changes', () => {
    expect(
      feed([denied('write'), denied('exec'), denied('write')], { repeatPolicyDeniedThreshold: 2 })
        .trip,
    ).toBeNull()
  })
})

describe('healthy run', () => {
  it('never trips on a normal interleaving of progress', () => {
    const signals: BreakerSignal[] = [
      call('read'),
      result('read', true),
      call('grep'),
      result('grep', true),
      cost(5_000, 0),
      call('edit'),
      result('edit', true),
      cost(5_000, 30_000),
      call('test'),
      result('test', true),
    ]
    expect(feed(signals, BREAKER_DEFAULTS).trip).toBeNull()
  })
})

describe('toolSignature', () => {
  it('is deterministic and distinguishes by name + input', () => {
    expect(toolSignature('read', { path: 'a' })).toBe(toolSignature('read', { path: 'a' }))
    expect(toolSignature('read', { path: 'a' })).not.toBe(toolSignature('read', { path: 'b' }))
    expect(toolSignature('read', { path: 'a' })).not.toBe(toolSignature('grep', { path: 'a' }))
  })
  it('tolerates unserializable input', () => {
    const circular: Record<string, unknown> = {}
    circular['self'] = circular
    expect(() => toolSignature('x', circular)).not.toThrow()
  })
})

describe('isPolicyDenialCode', () => {
  it('matches the typed denial codes case-insensitively', () => {
    expect(isPolicyDenialCode('policy_denied')).toBe(true)
    expect(isPolicyDenialCode('FORBIDDEN')).toBe(true)
    expect(isPolicyDenialCode('EPERM')).toBe(true)
  })
  it('ignores non-denial / empty codes', () => {
    expect(isPolicyDenialCode('Timeout')).toBe(false)
    expect(isPolicyDenialCode(null)).toBe(false)
    expect(isPolicyDenialCode('')).toBe(false)
  })
})
