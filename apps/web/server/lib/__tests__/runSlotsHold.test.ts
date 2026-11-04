// The run slots under an engine hold: a held engine starts no new run, however
// many slots are free, while the runs already holding a slot run to their end;
// the runs that asked meanwhile wait in order and start, in that order, once the
// hold lifts. The process's own slots follow the process's hold.

import { afterEach, describe, expect, it, vi } from 'vitest'

import { engineHold } from '../engineHold'
import {
  createRunSlots,
  runSlots,
  setRunSlotsForTests,
  waitForRunsToFinish,
  type RunSlot,
} from '../runSlots'

/** Let queued promise callbacks run. */
const flush = (): Promise<void> => new Promise((r) => setImmediate(r))

describe('run slots while the engine is held', () => {
  it('grants no slot, free or not, and queues every run that asks', async () => {
    let held = true
    const slots = createRunSlots(4, { held: () => held })
    expect(slots.tryAcquire()).toBeNull()
    expect(slots.tryAcquire('agent-a')).toBeNull()

    const started: string[] = []
    void slots.acquire().then(() => started.push('first'))
    void slots.acquire({ key: 'agent-a' }).then(() => started.push('second'))
    await flush()
    expect(started).toEqual([])
    expect(slots.stats()).toEqual({ size: 4, running: 0, queued: 2 })

    held = false
    slots.resume()
    await flush()
    expect(started).toEqual(['first', 'second'])
    expect(slots.stats()).toEqual({ size: 4, running: 2, queued: 0 })
  })

  it('lets a run already holding a slot finish, and gives its slot to no one', async () => {
    let held = false
    const slots = createRunSlots(1, { held: () => held })
    const inFlight = slots.tryAcquire()!
    expect(inFlight).not.toBeNull()

    held = true
    let next: RunSlot | null = null
    void slots.acquire().then((s) => (next = s))
    inFlight.release()
    await flush()
    // The in-flight run ended normally; the waiting one did not take its slot.
    expect(next).toBeNull()
    expect(slots.stats()).toEqual({ size: 1, running: 0, queued: 1 })

    held = false
    slots.resume()
    await flush()
    expect(next).not.toBeNull()
  })

  it('serves runs queued behind a hold that lapsed before a newcomer that asks after it', async () => {
    let held = true
    const slots = createRunSlots(1, { held: () => held })
    let queued: RunSlot | null = null
    void slots.acquire().then((s) => (queued = s))
    await flush()

    // The hold lapses, and a newcomer asks before anything has resumed the queue.
    held = false
    expect(slots.tryAcquire()).toBeNull()
    await flush()
    expect(queued).not.toBeNull()
  })

  it('takes a run out of the queue when its caller gives up during the hold', async () => {
    const slots = createRunSlots(2, { held: () => true })
    const cancel = new AbortController()
    const outcome = slots.acquire({ signal: cancel.signal }).then(
      () => 'granted',
      (err: Error) => err.name,
    )
    cancel.abort()
    expect(await outcome).toBe('RunQueueAbortedError')
    expect(slots.stats().queued).toBe(0)
  })
})

describe("the process's run slots and the process's hold", () => {
  afterEach(() => {
    engineHold().release('slots-test')
    setRunSlotsForTests(null)
  })

  it('stop starting runs when held, and start the waiting ones when released', async () => {
    setRunSlotsForTests(null)
    const running = runSlots().tryAcquire()!
    engineHold().place('slots-test', { reason: 'stop' })

    expect(runSlots().tryAcquire()).toBeNull()
    let waiting: RunSlot | null = null
    void runSlots()
      .acquire()
      .then((s) => (waiting = s))
    await flush()
    expect(waiting).toBeNull()
    expect(runSlots().stats()).toMatchObject({ running: 1, queued: 1 })

    // The run that was going when the hold came finishes as usual.
    running.release()
    expect(runSlots().stats()).toMatchObject({ running: 0, queued: 1 })

    expect(engineHold().release('slots-test')).toBe(true)
    await flush()
    expect(waiting).not.toBeNull()
    expect(runSlots().stats()).toMatchObject({ running: 1, queued: 0 })
    waiting!.release()
  })
})

describe('waitForRunsToFinish', () => {
  afterEach(() => {
    vi.useRealTimers()
    setRunSlotsForTests(null)
  })

  it('returns at once when no run holds a slot', async () => {
    setRunSlotsForTests(createRunSlots(2))
    const counts: number[] = []
    const result = await waitForRunsToFinish({ timeoutMs: 1_000, onRunning: (n) => counts.push(n) })
    expect(result).toEqual({ running: 0, timedOut: false })
    expect(counts).toEqual([0])
  })

  it('waits for the runs in flight and reports each change in their number', async () => {
    vi.useFakeTimers()
    setRunSlotsForTests(createRunSlots(2))
    const a = runSlots().tryAcquire()!
    const b = runSlots().tryAcquire()!
    const counts: number[] = []
    let result: { running: number; timedOut: boolean } | null = null
    void waitForRunsToFinish({ timeoutMs: 60_000, onRunning: (n) => counts.push(n) }).then(
      (r) => (result = r),
    )

    await vi.advanceTimersByTimeAsync(1_000)
    expect(result).toBeNull()
    a.release()
    await vi.advanceTimersByTimeAsync(500)
    expect(result).toBeNull()
    b.release()
    await vi.advanceTimersByTimeAsync(500)
    expect(result).toEqual({ running: 0, timedOut: false })
    expect(counts).toEqual([2, 1, 0])
  })

  it('gives up at its bound with the runs still going', async () => {
    vi.useFakeTimers()
    setRunSlotsForTests(createRunSlots(1))
    const slot = runSlots().tryAcquire()!
    let result: { running: number; timedOut: boolean } | null = null
    void waitForRunsToFinish({ timeoutMs: 3_000 }).then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(2_999)
    expect(result).toBeNull()
    await vi.advanceTimersByTimeAsync(1)
    expect(result).toEqual({ running: 1, timedOut: true })
    slot.release()
  })

  it('stops waiting at once when its signal aborts', async () => {
    vi.useFakeTimers()
    setRunSlotsForTests(createRunSlots(1))
    const slot = runSlots().tryAcquire()!
    const force = new AbortController()
    let result: { running: number; timedOut: boolean } | null = null
    void waitForRunsToFinish({ timeoutMs: 60_000, signal: force.signal }).then((r) => (result = r))
    await vi.advanceTimersByTimeAsync(100)
    force.abort()
    await vi.advanceTimersByTimeAsync(0)
    expect(result).toEqual({ running: 1, timedOut: false })
    slot.release()
  })
})
