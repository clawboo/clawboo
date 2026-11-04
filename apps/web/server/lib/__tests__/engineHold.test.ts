// The engine hold's own rules: a hold belongs to its owner id, only that id
// releases it, it lapses after its time to live unless renewed, and the engine
// resumes (its listeners run) only when the last hold lifts.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  HOLD_TTL_DEFAULT_MS,
  HOLD_TTL_MAX_MS,
  HOLD_TTL_MIN_MS,
  clampHoldTtl,
  createEngineHolds,
} from '../engineHold'

/** Let queued microtasks (the resume listeners) run. */
const flush = (): Promise<void> => Promise.resolve().then(() => undefined)

describe('engine holds', () => {
  beforeEach(() => {
    vi.useFakeTimers()
    vi.setSystemTime(1_000_000)
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('holds from the first place until its owner releases it', async () => {
    const holds = createEngineHolds()
    const resumed = vi.fn()
    holds.onResume(resumed)
    expect(holds.isHeld()).toBe(false)

    const hold = holds.place('cli-stop', { ttlMs: 30_000, reason: 'stop' })
    expect(hold).toEqual({
      owner: 'cli-stop',
      reason: 'stop',
      heldAt: 1_000_000,
      expiresAt: 1_030_000,
    })
    expect(holds.isHeld()).toBe(true)
    expect(holds.list()).toEqual([hold])

    expect(holds.release('cli-stop')).toBe(true)
    expect(holds.isHeld()).toBe(false)
    await flush()
    expect(resumed).toHaveBeenCalledTimes(1)
  })

  it('refuses a release by any other owner id and stays held', async () => {
    const holds = createEngineHolds()
    const resumed = vi.fn()
    holds.onResume(resumed)
    holds.place('updater')

    expect(holds.release('someone-else')).toBe(false)
    expect(holds.release('UPDATER')).toBe(false)
    expect(holds.isHeld()).toBe(true)
    expect(holds.list().map((h) => h.owner)).toEqual(['updater'])
    await flush()
    expect(resumed).not.toHaveBeenCalled()
  })

  it('lapses after its time to live and resumes the engine with no one reading it', async () => {
    const holds = createEngineHolds()
    const resumed = vi.fn()
    holds.onResume(resumed)
    holds.place('crashed-holder', { ttlMs: 10_000 })

    vi.advanceTimersByTime(9_999)
    await flush()
    expect(resumed).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1)
    await flush()
    // The timer, not a read, lifted it: the run queue resumes on its own.
    expect(resumed).toHaveBeenCalledTimes(1)
    expect(holds.isHeld()).toBe(false)
    expect(holds.list()).toEqual([])
    // A lapsed hold cannot be released afterwards.
    expect(holds.release('crashed-holder')).toBe(false)
  })

  it('keeps a hold its owner renews before it lapses, from the same start', async () => {
    const holds = createEngineHolds()
    const resumed = vi.fn()
    holds.onResume(resumed)
    holds.place('process-manager', { ttlMs: 10_000, reason: 'restart' })

    vi.advanceTimersByTime(8_000)
    const renewed = holds.place('process-manager', { ttlMs: 10_000 })
    expect(renewed.heldAt).toBe(1_000_000)
    expect(renewed.expiresAt).toBe(1_018_000)
    // A renewal that names no reason keeps the one it had.
    expect(renewed.reason).toBe('restart')

    vi.advanceTimersByTime(9_000)
    await flush()
    expect(holds.isHeld()).toBe(true)
    expect(resumed).not.toHaveBeenCalled()

    vi.advanceTimersByTime(1_000)
    await flush()
    expect(holds.isHeld()).toBe(false)
    expect(resumed).toHaveBeenCalledTimes(1)
  })

  it('stays held while any owner holds, and resumes only when the last lifts', async () => {
    const holds = createEngineHolds()
    const resumed = vi.fn()
    holds.onResume(resumed)
    holds.place('a', { ttlMs: 60_000 })
    vi.advanceTimersByTime(1_000)
    holds.place('b', { ttlMs: 5_000 })
    expect(holds.list().map((h) => h.owner)).toEqual(['a', 'b'])

    // b lapses first; a still holds.
    vi.advanceTimersByTime(5_000)
    await flush()
    expect(holds.isHeld()).toBe(true)
    expect(holds.list().map((h) => h.owner)).toEqual(['a'])
    expect(resumed).not.toHaveBeenCalled()

    expect(holds.release('a')).toBe(true)
    await flush()
    expect(resumed).toHaveBeenCalledTimes(1)
  })

  it('releases only the owner that asks, leaving every other hold in place', async () => {
    const holds = createEngineHolds()
    const resumed = vi.fn()
    holds.onResume(resumed)
    holds.place('updater')
    holds.place('clawboo-stop-1')

    expect(holds.release('clawboo-stop-1')).toBe(true)
    expect(holds.list().map((h) => h.owner)).toEqual(['updater'])
    expect(holds.isHeld()).toBe(true)
    await flush()
    expect(resumed).not.toHaveBeenCalled()
  })

  it('runs no resume listener when a new hold arrives before the listeners do', async () => {
    const holds = createEngineHolds()
    const resumed = vi.fn()
    holds.onResume(resumed)
    holds.place('a')
    holds.release('a')
    holds.place('b')
    await flush()
    expect(resumed).not.toHaveBeenCalled()
    expect(holds.isHeld()).toBe(true)
  })

  it('stops calling a listener that unsubscribed, and survives one that throws', async () => {
    const holds = createEngineHolds()
    const gone = vi.fn()
    const after = vi.fn()
    const off = holds.onResume(gone)
    holds.onResume(() => {
      throw new Error('boom')
    })
    holds.onResume(after)
    off()
    holds.place('a')
    holds.release('a')
    await flush()
    expect(gone).not.toHaveBeenCalled()
    expect(after).toHaveBeenCalledTimes(1)
  })

  it('keeps every time to live inside its bounds', () => {
    expect(clampHoldTtl(undefined)).toBe(HOLD_TTL_DEFAULT_MS)
    expect(clampHoldTtl(Number.NaN)).toBe(HOLD_TTL_DEFAULT_MS)
    expect(clampHoldTtl(1)).toBe(HOLD_TTL_MIN_MS)
    expect(clampHoldTtl(Number.MAX_SAFE_INTEGER)).toBe(HOLD_TTL_MAX_MS)
    expect(clampHoldTtl(20_000)).toBe(20_000)
  })
})
