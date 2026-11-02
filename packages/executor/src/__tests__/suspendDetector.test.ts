import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createSuspendDetector, setAwakeTimeout, SUSPEND_GAP_FACTOR } from '../suspendDetector'

const INTERVAL = 30_000

describe('createSuspendDetector', () => {
  it('the first tick only records a baseline when none is given', () => {
    const suspendedFor = createSuspendDetector(INTERVAL)
    expect(suspendedFor(1_000)).toBe(0)
    expect(suspendedFor(1_000 + 60 * 60_000)).toBe(60 * 60_000 - INTERVAL)
  })

  it('measures the first tick from the given baseline', () => {
    const suspendedFor = createSuspendDetector(INTERVAL, 1_000)
    expect(suspendedFor(1_000 + 30 * 60_000)).toBe(30 * 60_000 - INTERVAL)
  })

  it('an on-time or merely late tick is not a suspension', () => {
    const suspendedFor = createSuspendDetector(INTERVAL, 0)
    expect(suspendedFor(INTERVAL)).toBe(0)
    expect(suspendedFor(INTERVAL + INTERVAL + 5_000)).toBe(0)
    expect(suspendedFor(INTERVAL + INTERVAL + 5_000 + SUSPEND_GAP_FACTOR * INTERVAL)).toBe(0)
  })

  it('a long gap is a suspension, less the one interval that may have been awake', () => {
    const suspendedFor = createSuspendDetector(INTERVAL, 0)
    expect(suspendedFor(INTERVAL)).toBe(0)
    expect(suspendedFor(INTERVAL + 10 * 60_000)).toBe(10 * 60_000 - INTERVAL)
    // Counted once: the next ordinary tick is measured from the wake.
    expect(suspendedFor(2 * INTERVAL + 10 * 60_000)).toBe(0)
  })

  it('a clock that steps backwards is not a suspension', () => {
    const suspendedFor = createSuspendDetector(INTERVAL, 10 * 60_000)
    expect(suspendedFor(60_000)).toBe(0)
    expect(suspendedFor(60_000 + INTERVAL)).toBe(0)
  })

  it('a non-positive interval detects nothing', () => {
    expect(createSuspendDetector(0, 0)(60 * 60_000)).toBe(0)
    expect(createSuspendDetector(-1, 0)(60 * 60_000)).toBe(0)
  })
})

/** A macOS sleep under fake timers: the wall clock jumps and every timer whose
 *  delay passed fires once, on wake. (`vi.setSystemTime` would move the pending
 *  timers along with the clock, so a plain setTimeout would pass too.) */
const sleepFor = (ms: number): void =>
  (globalThis.setTimeout as unknown as { clock: { jump(ms: number): void } }).clock.jump(ms)

describe('setAwakeTimeout', () => {
  const MIN = 60_000

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it('fires after its delay of awake time, like setTimeout', () => {
    const fn = vi.fn()
    setAwakeTimeout(fn, 10 * MIN)
    vi.advanceTimersByTime(10 * MIN - 1)
    expect(fn).not.toHaveBeenCalled()
    vi.advanceTimersByTime(1)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a delay shorter than one tick fires on time', () => {
    const fn = vi.fn()
    setAwakeTimeout(fn, 50)
    vi.advanceTimersByTime(50)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('a sleep longer than the delay does not fire it on wake', () => {
    const fn = vi.fn()
    setAwakeTimeout(fn, 10 * MIN)
    vi.advanceTimersByTime(4 * MIN)

    sleepFor(60 * MIN)
    expect(fn).not.toHaveBeenCalled()

    // The rest of its awake time still runs out.
    vi.advanceTimersByTime(6 * MIN)
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('clear stops it', () => {
    const fn = vi.fn()
    const t = setAwakeTimeout(fn, 10 * MIN)
    vi.advanceTimersByTime(5 * MIN)
    t.clear()
    vi.advanceTimersByTime(60 * MIN)
    expect(fn).not.toHaveBeenCalled()
  })
})
