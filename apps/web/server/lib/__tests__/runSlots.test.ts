// The process-wide run cap: a first-come counting semaphore. Every run start takes
// a slot and gives it back on its terminal, an abort or a throw, so these pin the
// properties every caller leans on: the cap holds, waiters are served in order, a
// slot can be given back any number of times but counts once, and a cancelled
// waiter leaves the queue without a slot.

import { afterEach, describe, expect, it } from 'vitest'

import {
  DEFAULT_MAX_CONCURRENT_RUNS,
  RunQueueAbortedError,
  createRunSlots,
  maxConcurrentRunsFromEnv,
  runSlots,
  setRunSlotsForTests,
  withRunSlot,
  type RunSlot,
} from '../runSlots'

/** Let queued promise callbacks run. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('createRunSlots', () => {
  it('grants up to the cap and refuses beyond it', () => {
    const slots = createRunSlots(2)
    const a = slots.tryAcquire()
    const b = slots.tryAcquire()
    expect(a).not.toBeNull()
    expect(b).not.toBeNull()
    expect(slots.tryAcquire()).toBeNull()
    expect(slots.stats()).toEqual({ size: 2, running: 2, queued: 0 })
    a!.release()
    expect(slots.stats().running).toBe(1)
    expect(slots.tryAcquire()).not.toBeNull()
  })

  it('serves waiters first come, first served', async () => {
    const slots = createRunSlots(1)
    const first = slots.tryAcquire()!
    const order: string[] = []
    const held: Record<string, RunSlot> = {}
    for (const name of ['b', 'c', 'd']) {
      void slots.acquire().then((s) => {
        order.push(name)
        held[name] = s
      })
    }
    await flush()
    expect(order).toEqual([])
    expect(slots.stats()).toEqual({ size: 1, running: 1, queued: 3 })

    first.release()
    await flush()
    expect(order).toEqual(['b'])
    held['b']!.release()
    await flush()
    held['c']!.release()
    await flush()
    expect(order).toEqual(['b', 'c', 'd'])
    held['d']!.release()
    expect(slots.stats()).toEqual({ size: 1, running: 0, queued: 0 })
  })

  it('counts a release once, however many times it is called', async () => {
    const slots = createRunSlots(1)
    const a = slots.tryAcquire()!
    let bGot: RunSlot | null = null
    void slots.acquire().then((s) => (bGot = s))
    a.release()
    a.release()
    a.release()
    await flush()
    // The repeat releases neither freed a second slot nor skipped the waiter.
    expect(bGot).not.toBeNull()
    expect(slots.stats()).toEqual({ size: 1, running: 1, queued: 0 })
    expect(slots.tryAcquire()).toBeNull()
    bGot!.release()
    bGot!.release()
    expect(slots.stats().running).toBe(0)
  })

  it('hands a freed slot to the oldest waiter, never to a later tryAcquire', async () => {
    const slots = createRunSlots(1)
    const a = slots.tryAcquire()!
    let waiterGot = false
    void slots.acquire().then(() => (waiterGot = true))
    a.release()
    // Before the waiter's callback has even run, the slot is already its own.
    expect(slots.tryAcquire()).toBeNull()
    expect(slots.stats()).toEqual({ size: 1, running: 1, queued: 0 })
    await flush()
    expect(waiterGot).toBe(true)
  })

  it('does not let a fresh tryAcquire jump the queue while runs wait', async () => {
    const slots = createRunSlots(2)
    const a = slots.tryAcquire()!
    const b = slots.tryAcquire()!
    const waiting = slots.acquire()
    a.release()
    await flush()
    // The freed slot went to the waiter, so the cap is full again.
    expect(slots.tryAcquire()).toBeNull()
    ;(await waiting).release()
    b.release()
    expect(slots.stats()).toEqual({ size: 2, running: 0, queued: 0 })
  })

  it('takes a cancelled waiter out of the queue without a slot', async () => {
    const slots = createRunSlots(1)
    const a = slots.tryAcquire()!
    const ctl = new AbortController()
    const cancelled = slots.acquire({ signal: ctl.signal })
    let nextGot = false
    void slots.acquire().then(() => (nextGot = true))
    expect(slots.stats().queued).toBe(2)

    ctl.abort()
    await expect(cancelled).rejects.toBeInstanceOf(RunQueueAbortedError)
    expect(slots.stats()).toEqual({ size: 1, running: 1, queued: 1 })

    // The freed slot skips the cancelled run and goes to the one behind it.
    a.release()
    await flush()
    expect(nextGot).toBe(true)
    expect(slots.stats()).toEqual({ size: 1, running: 1, queued: 0 })
  })

  it('refuses at once when the signal has already aborted and no slot is free', async () => {
    const slots = createRunSlots(1)
    slots.tryAcquire()
    const ctl = new AbortController()
    ctl.abort()
    await expect(slots.acquire({ signal: ctl.signal })).rejects.toBeInstanceOf(RunQueueAbortedError)
    expect(slots.stats().queued).toBe(0)
  })

  it('refuses a signal that has already aborted even when a slot is free, and takes none', async () => {
    const slots = createRunSlots(1)
    const ctl = new AbortController()
    ctl.abort()
    await expect(slots.acquire({ signal: ctl.signal, key: 'home:a' })).rejects.toBeInstanceOf(
      RunQueueAbortedError,
    )
    expect(slots.stats()).toEqual({ size: 1, running: 0, queued: 0 })
    // Neither the slot nor the agent's key stayed taken.
    expect(slots.tryAcquire('home:a')).not.toBeNull()
  })

  it('keeps a granted slot when the signal aborts afterwards', async () => {
    const slots = createRunSlots(1)
    const ctl = new AbortController()
    const slot = await slots.acquire({ signal: ctl.signal })
    ctl.abort()
    expect(slots.stats().running).toBe(1)
    slot.release()
    expect(slots.stats().running).toBe(0)
  })

  it('rejects a size that is not a whole number of at least 1', () => {
    expect(() => createRunSlots(0)).toThrow(RangeError)
    expect(() => createRunSlots(-1)).toThrow(RangeError)
    expect(() => createRunSlots(1.5)).toThrow(RangeError)
    expect(() => createRunSlots(Number.NaN)).toThrow(RangeError)
  })
})

describe('createRunSlots with agent keys', () => {
  it('never gives one key two slots at once', () => {
    const slots = createRunSlots(3)
    const a = slots.tryAcquire('home:a')
    expect(a).not.toBeNull()
    expect(slots.tryAcquire('home:a')).toBeNull()
    expect(slots.tryAcquire('home:b')).not.toBeNull()
    // A run that takes no agent lock is never held back by one.
    expect(slots.tryAcquire()).not.toBeNull()
    a!.release()
    expect(slots.tryAcquire('home:a')).not.toBeNull()
  })

  it("lets other agents' runs pass a run waiting on its own busy agent, without a slot", async () => {
    const slots = createRunSlots(2)
    const a1 = slots.tryAcquire('home:a')!
    const order: string[] = []
    const held: Record<string, RunSlot> = {}
    const want = (name: string, key: string): void => {
      void slots.acquire({ key }).then((s) => {
        order.push(name)
        held[name] = s
      })
    }
    want('a2', 'home:a')
    want('b1', 'home:b')
    await flush()
    // b1 arrived later but took the free slot; a2 waits for a1 without taking one.
    expect(order).toEqual(['b1'])
    expect(slots.stats()).toEqual({ size: 2, running: 2, queued: 1 })

    a1.release()
    await flush()
    expect(order).toEqual(['b1', 'a2'])
    held['a2']!.release()
    held['b1']!.release()
    expect(slots.stats()).toEqual({ size: 2, running: 0, queued: 0 })
  })

  it("serves one agent's waiters in order as each run gives its slot back", async () => {
    const slots = createRunSlots(4)
    const first = slots.tryAcquire('home:a')!
    const order: string[] = []
    const held: RunSlot[] = []
    for (const name of ['a2', 'a3']) {
      void slots.acquire({ key: 'home:a' }).then((s) => {
        order.push(name)
        held.push(s)
      })
    }
    await flush()
    expect(slots.stats()).toEqual({ size: 4, running: 1, queued: 2 })
    first.release()
    await flush()
    expect(order).toEqual(['a2'])
    held[0]!.release()
    await flush()
    expect(order).toEqual(['a2', 'a3'])
    held[1]!.release()
    expect(slots.stats().running).toBe(0)
  })

  it('when the slot that frees is not its own agent, the oldest runnable waiter gets it', async () => {
    const slots = createRunSlots(2)
    const a1 = slots.tryAcquire('home:a')!
    const b1 = slots.tryAcquire('home:b')!
    const order: string[] = []
    for (const [name, key] of [
      ['a2', 'home:a'],
      ['c1', 'home:c'],
      ['b2', 'home:b'],
    ] as const) {
      void slots.acquire({ key }).then(() => order.push(name))
    }
    await flush()
    expect(order).toEqual([])
    // b1's slot frees: a2 is older but its agent still runs, so c1 goes first.
    b1.release()
    await flush()
    expect(order).toEqual(['c1'])
    a1.release()
    await flush()
    expect(order).toEqual(['c1', 'a2'])
  })
})

describe('maxConcurrentRunsFromEnv', () => {
  it('uses the default when unset or empty', () => {
    expect(DEFAULT_MAX_CONCURRENT_RUNS).toBe(8)
    expect(maxConcurrentRunsFromEnv(undefined)).toBe(8)
    expect(maxConcurrentRunsFromEnv('')).toBe(8)
    expect(maxConcurrentRunsFromEnv('   ')).toBe(8)
  })

  it('takes a whole number of at least 1', () => {
    expect(maxConcurrentRunsFromEnv('1')).toBe(1)
    expect(maxConcurrentRunsFromEnv('20')).toBe(20)
    expect(maxConcurrentRunsFromEnv(' 4 ')).toBe(4)
  })

  it('falls back to the default for anything else, so a typo never removes the cap', () => {
    for (const raw of ['0', '-3', '2.5', 'eight', 'Infinity', '1e400']) {
      expect(maxConcurrentRunsFromEnv(raw), raw).toBe(8)
    }
  })
})

describe('the shared slots', () => {
  const prev = process.env['CLAWBOO_MAX_CONCURRENT_RUNS']
  afterEach(() => {
    if (prev === undefined) delete process.env['CLAWBOO_MAX_CONCURRENT_RUNS']
    else process.env['CLAWBOO_MAX_CONCURRENT_RUNS'] = prev
    setRunSlotsForTests(null)
  })

  it('are sized from CLAWBOO_MAX_CONCURRENT_RUNS on first use, then fixed', () => {
    process.env['CLAWBOO_MAX_CONCURRENT_RUNS'] = '3'
    setRunSlotsForTests(null)
    const slots = runSlots()
    expect(slots.size).toBe(3)
    process.env['CLAWBOO_MAX_CONCURRENT_RUNS'] = '5'
    expect(runSlots()).toBe(slots)
  })

  it('withRunSlot gives the slot back when the work succeeds or throws', async () => {
    const slots = createRunSlots(1)
    setRunSlotsForTests(slots)
    await expect(withRunSlot(async () => 'ok')).resolves.toBe('ok')
    expect(slots.stats().running).toBe(0)
    await expect(
      withRunSlot(async () => {
        throw new Error('boom')
      }),
    ).rejects.toThrow('boom')
    expect(slots.stats().running).toBe(0)
  })

  it('withRunSlot never runs the work of a run cancelled while queued', async () => {
    const slots = createRunSlots(1)
    setRunSlotsForTests(slots)
    const held = slots.tryAcquire()!
    const ctl = new AbortController()
    let ran = false
    const queued = withRunSlot(
      async () => {
        ran = true
      },
      { signal: ctl.signal },
    )
    ctl.abort()
    await expect(queued).rejects.toBeInstanceOf(RunQueueAbortedError)
    held.release()
    await flush()
    expect(ran).toBe(false)
    expect(slots.stats()).toEqual({ size: 1, running: 0, queued: 0 })
  })
})
