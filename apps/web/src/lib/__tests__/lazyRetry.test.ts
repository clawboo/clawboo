// createRetryableLazy — the mechanism that makes "Try again" able to re-run a
// failed dynamic import. React.lazy memoizes a REJECTED factory on the lazy
// object forever, so recovery needs a NEW lazy per attempt; these assertions pin
// exactly that, plus the stability that keeps a healthy panel from remounting.

import { describe, expect, it } from 'vitest'

import { createRetryableLazy } from '../lazyRetry'

describe('createRetryableLazy', () => {
  it('returns a STABLE component per attempt, so re-renders do not remount or re-suspend', () => {
    const source = createRetryableLazy(async () => ({ default: () => null }))
    expect(source.get(0)).toBe(source.get(0))
  })

  it('returns a DIFFERENT component for a new attempt, so import() can run again', () => {
    const source = createRetryableLazy(async () => ({ default: () => null }))
    expect(source.get(1)).not.toBe(source.get(0))
  })

  it('keeps older attempts cached — a peer instance still rendering one must not remount', () => {
    const source = createRetryableLazy(async () => ({ default: () => null }))
    const first = source.get(0)
    source.get(1)
    expect(source.get(0)).toBe(first)
  })

  it('tracks the attempt index at module scope so a successful retry survives a remount', () => {
    const source = createRetryableLazy(async () => ({ default: () => null }))
    expect(source.currentAttempt()).toBe(0)
    expect(source.nextAttempt()).toBe(1)
    // The point: a consumer mounting later (ContentArea remounts the whole view
    // subtree on navigation) picks up the successful retry rather than starting
    // over on the attempt that already failed.
    expect(source.currentAttempt()).toBe(1)
  })

  it('does not call the loader until the lazy is actually rendered', () => {
    let loads = 0
    const source = createRetryableLazy(async () => {
      loads += 1
      return { default: () => null }
    })
    source.get(0)
    source.get(1)
    expect(loads).toBe(0)
  })

  it('gives each source its own cache and counter', () => {
    const a = createRetryableLazy(async () => ({ default: () => null }))
    const b = createRetryableLazy(async () => ({ default: () => null }))
    a.nextAttempt()
    expect(a.currentAttempt()).toBe(1)
    expect(b.currentAttempt()).toBe(0)
    expect(a.get(0)).not.toBe(b.get(0))
  })
})
