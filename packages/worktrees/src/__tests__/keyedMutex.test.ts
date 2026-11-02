import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { KeyedMutex, MutexAcquireTimeoutError } from '../git'

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms))

describe('KeyedMutex', () => {
  it('serializes same-key ops; different keys run concurrently', async () => {
    const m = new KeyedMutex()
    const order: string[] = []
    const a = m.run('k1', async () => {
      order.push('a-start')
      await sleep(40)
      order.push('a-end')
    })
    const b = m.run('k1', async () => {
      order.push('b-start')
    })
    const c = m.run('k2', async () => {
      order.push('c-start')
    })
    await Promise.all([a, b, c])
    // b waited for a; c (other key) did not.
    expect(order.indexOf('b-start')).toBeGreaterThan(order.indexOf('a-end'))
    expect(order.indexOf('c-start')).toBeLessThan(order.indexOf('a-end'))
  })

  it('a waiter behind a wedged holder rejects at its acquire timeout', async () => {
    const m = new KeyedMutex()
    let release!: () => void
    void m.run('k', () => new Promise<void>((r) => (release = r))) // the wedged holder
    await expect(m.run('k', async () => 'ran', { acquireTimeoutMs: 50 })).rejects.toBeInstanceOf(
      MutexAcquireTimeoutError,
    )
    release()
  })

  it('a timed-out waiter does NOT let the next caller run beside the holder', async () => {
    const m = new KeyedMutex()
    const order: string[] = []
    let release!: () => void
    void m.run('k', () => {
      order.push('holder-start')
      return new Promise<void>((r) => (release = r))
    })
    await m.run('k', async () => undefined, { acquireTimeoutMs: 40 }).catch(() => undefined)
    const third = m.run('k', async () => {
      order.push('third-ran')
    })
    // The holder still holds the key: the third caller must wait for it.
    await sleep(60)
    expect(order).toEqual(['holder-start'])
    release()
    await third
    expect(order).toEqual(['holder-start', 'third-ran'])
  })

  it('acquire succeeds normally when the holder releases in time', async () => {
    const m = new KeyedMutex()
    void m.run('k', () => sleep(20))
    await expect(m.run('k', async () => 'ran', { acquireTimeoutMs: 500 })).resolves.toBe('ran')
  })
})

describe('the acquire timeout counts awake time', () => {
  const MIN = 60_000
  const ACQUIRE_MS = 10 * MIN

  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  /** What a sleep does to the process on macOS: the wall clock jumps, and every
   *  timer whose delay passed fires once on wake. `vi.setSystemTime` alone moves
   *  pending timers along with the clock, so a plain timer would never notice. */
  function sleepMachine(ms: number): void {
    ;(globalThis.setTimeout as unknown as { clock: { jump(ms: number): void } }).clock.jump(ms)
  }

  /** Queue a bounded waiter behind a holder that runs until `release`. */
  function queueBehindHolder(): {
    release: () => void
    outcome: () => 'pending' | 'ran' | 'timed-out'
  } {
    const m = new KeyedMutex()
    let release!: () => void
    void m.run('k', () => new Promise<void>((r) => (release = r)))
    let outcome: 'pending' | 'ran' | 'timed-out' = 'pending'
    m.run('k', async () => 'ran', { acquireTimeoutMs: ACQUIRE_MS }).then(
      () => (outcome = 'ran'),
      (err: unknown) => {
        if (err instanceof MutexAcquireTimeoutError) outcome = 'timed-out'
      },
    )
    return { release: () => release(), outcome: () => outcome }
  }

  it('a sleep longer than the timeout does not fail a waiter behind a healthy run', async () => {
    const waiter = queueBehindHolder()
    await vi.advanceTimersByTimeAsync(4 * MIN)

    // The machine sleeps for an hour, then one tick runs on wake.
    sleepMachine(60 * MIN)
    await vi.advanceTimersByTimeAsync(30_000)
    expect(waiter.outcome()).toBe('pending')

    // The holder finishes after the wake and the waiter gets its turn.
    waiter.release()
    await vi.advanceTimersByTimeAsync(0)
    expect(waiter.outcome()).toBe('ran')
  })

  it('a holder that really stays wedged still times the waiter out at the limit', async () => {
    const waiter = queueBehindHolder()
    await vi.advanceTimersByTimeAsync(ACQUIRE_MS - 1)
    expect(waiter.outcome()).toBe('pending')
    await vi.advanceTimersByTimeAsync(1)
    expect(waiter.outcome()).toBe('timed-out')
    waiter.release()
  })
})

describe('the acquire timeout is catchable by name', () => {
  it('MutexAcquireTimeoutError is re-exported from the package barrel', async () => {
    // The acquire timeout shipped without a barrel export, so the one rejection
    // class the mutex can produce was unreachable to consumers. Both callers
    // swallowed it as a generic error, which is how a wedged home became a silent
    // non-response in 1:1 chat and an aborted round in a team exchange.
    const barrel = await import('../index')
    expect(barrel.MutexAcquireTimeoutError).toBe(MutexAcquireTimeoutError)
  })
})
