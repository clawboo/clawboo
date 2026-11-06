// The watcher behind the badge: one read per burst of events, no timer of its own.
// It is woken by the app's one event tail, so a quiet board costs nothing.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createInboxWatcher, type InboxWatcher } from '../inboxWatcher'

const BATCH = 1000
const RETRIES = [5_000, 20_000, 60_000]

let watcher: InboxWatcher
let reads: number
let answers: Array<() => void>
let results: boolean[]

/** A read that stays out until the test answers it. */
function read(): Promise<boolean> {
  reads += 1
  const ok = results.shift() ?? true
  return new Promise((resolve) => answers.push(() => resolve(ok)))
}
async function answer(): Promise<void> {
  answers.shift()?.()
  await vi.advanceTimersByTimeAsync(0)
}

beforeEach(() => {
  vi.useFakeTimers()
  reads = 0
  answers = []
  results = []
  watcher = createInboxWatcher({ read, batchMs: BATCH, retryMs: RETRIES })
})
afterEach(() => {
  watcher.stop()
  vi.useRealTimers()
})

describe('createInboxWatcher', () => {
  it('reads nothing and holds no timer until something wakes it', async () => {
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reads).toBe(0)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('turns a burst of events into one read, a moment later', async () => {
    watcher.poke()
    watcher.poke()
    await vi.advanceTimersByTimeAsync(BATCH - 1)
    watcher.poke()
    expect(reads).toBe(0)
    await vi.advanceTimersByTimeAsync(1)
    expect(reads).toBe(1)
    await answer()
    expect(reads).toBe(1)
  })

  it('goes quiet after a read: no timer is left running', async () => {
    watcher.poke()
    await vi.advanceTimersByTimeAsync(BATCH)
    await answer()
    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reads).toBe(1)
  })

  it('a read that keeps being woken still happens: throttled, not debounced', async () => {
    watcher.poke()
    await vi.advanceTimersByTimeAsync(600)
    watcher.poke()
    await vi.advanceTimersByTimeAsync(600)
    expect(reads).toBe(1)
  })

  it('does not lose an update that lands while a read is out', async () => {
    watcher.poke()
    await vi.advanceTimersByTimeAsync(BATCH)
    expect(reads).toBe(1)

    // The read is already on the wire, so it may not have seen this one.
    watcher.poke()
    await vi.advanceTimersByTimeAsync(BATCH)
    expect(reads).toBe(1)
    await answer()
    await vi.advanceTimersByTimeAsync(BATCH)
    expect(reads).toBe(2)
    await answer()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reads).toBe(2)
  })

  it('tries a failed read again a few times, then waits for the next event', async () => {
    results = [false, false, false, false]
    watcher.poke()
    await vi.advanceTimersByTimeAsync(BATCH)
    expect(reads).toBe(1)
    await answer()

    await vi.advanceTimersByTimeAsync(RETRIES[0]!)
    expect(reads).toBe(2)
    await answer()
    await vi.advanceTimersByTimeAsync(RETRIES[1]!)
    expect(reads).toBe(3)
    await answer()
    await vi.advanceTimersByTimeAsync(RETRIES[2]!)
    expect(reads).toBe(4)
    await answer()

    expect(vi.getTimerCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reads).toBe(4)

    // The next event starts over.
    results = [true]
    watcher.poke()
    await vi.advanceTimersByTimeAsync(BATCH)
    expect(reads).toBe(5)
  })

  it('a good read ends the retries', async () => {
    results = [false, true]
    watcher.poke()
    await vi.advanceTimersByTimeAsync(BATCH)
    await answer()
    await vi.advanceTimersByTimeAsync(RETRIES[0]!)
    expect(reads).toBe(2)
    await answer()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reads).toBe(2)
  })

  it('readNow reads straight away, and queues behind a read already out', async () => {
    void watcher.readNow()
    expect(reads).toBe(1)
    void watcher.readNow()
    expect(reads).toBe(1)
    await answer()
    expect(reads).toBe(2)
  })

  it('stop drops whatever was waiting', async () => {
    watcher.poke()
    watcher.stop()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reads).toBe(0)
    watcher.poke()
    await vi.advanceTimersByTimeAsync(600_000)
    expect(reads).toBe(0)
  })
})
