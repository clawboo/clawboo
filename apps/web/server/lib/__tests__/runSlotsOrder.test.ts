// The order the run queue hands out slots in, and the pause it honours. Without an
// order an urgent task, already claimed, waited behind every run queued before it
// across every team; without the pause a paused agent started from the queue the
// moment a slot freed.

import { describe, expect, it, vi } from 'vitest'

import {
  createRunSlots,
  PERSON_TURN,
  PERSON_TURNS_BEFORE_WORK,
  RUN_QUEUE_AGING_MS,
  RunQueueAbortedError,
  type RunRank,
  type RunSlot,
  type RunSlotRequest,
  type RunSlots,
} from '../runSlots'

/** Queue a run under `name`; `started` records the order slots were granted in. */
function queue(
  slots: RunSlots,
  started: string[],
  name: string,
  request: RunSlotRequest = {},
): { slot: () => RunSlot; result: Promise<RunSlot> } {
  let held: RunSlot | null = null
  const result = slots.acquire(request).then((s) => {
    started.push(name)
    held = s
    return s
  })
  return {
    slot: () => {
      if (!held) throw new Error(`${name} has no slot`)
      return held
    },
    result,
  }
}

const flush = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) await Promise.resolve()
}

const work = (priority: number): RunRank => ({ priority })

/** Slots of `size`, all taken by a holder that frees one per `next()` call. */
function saturated(size = 1, options: Parameters<typeof createRunSlots>[1] = {}) {
  const slots = createRunSlots(size, options)
  const holders: RunSlot[] = []
  for (let i = 0; i < size; i++) holders.push(slots.tryAcquire()!)
  return { slots, free: () => holders.pop()!.release(), hold: (s: RunSlot) => holders.push(s) }
}

describe('the order of the run queue', () => {
  it('serves equal priority first come, first served', async () => {
    const { slots, free } = saturated()
    const started: string[] = []
    const a = queue(slots, started, 'a')
    queue(slots, started, 'b')
    free()
    await flush()
    a.slot().release()
    await flush()
    expect(started).toEqual(['a', 'b'])
  })

  it('starts an urgent task ahead of a long first-come queue', async () => {
    const { slots, free } = saturated()
    const started: string[] = []
    for (const name of ['n1', 'n2', 'n3']) queue(slots, started, name, { rank: work(0) })
    queue(slots, started, 'urgent', { rank: work(2) })
    free()
    await flush()
    expect(started).toEqual(['urgent'])
  })

  it('lets a low-priority run through once it has waited long enough', async () => {
    let at = 1_000_000
    const { slots, free } = saturated(1, { now: () => at })
    const started: string[] = []
    queue(slots, started, 'low', { rank: work(-1) })
    at += 3 * RUN_QUEUE_AGING_MS
    // Three steps took it from low (-1) to urgent (2), and it came first.
    queue(slots, started, 'fresh urgent', { rank: work(2) })
    free()
    await flush()
    expect(started).toEqual(['low'])
  })

  it('keeps an urgent run ahead of runs that have only waited a little', async () => {
    let at = 1_000_000
    const { slots, free } = saturated(1, { now: () => at })
    const started: string[] = []
    queue(slots, started, 'normal', { rank: work(0) })
    at += RUN_QUEUE_AGING_MS - 1
    queue(slots, started, 'fresh urgent', { rank: work(2) })
    free()
    await flush()
    expect(started).toEqual(['fresh urgent'])
  })

  it('never gives a slot to a run whose agent holds one, however urgent, and serves the next', async () => {
    const slots = createRunSlots(2)
    const busy = slots.tryAcquire('agent-a')!
    const other = slots.tryAcquire('agent-b')!
    const started: string[] = []
    const urgent = queue(slots, started, 'urgent on a', { key: 'agent-a', rank: work(2) })
    queue(slots, started, 'normal on c', { key: 'agent-c', rank: work(0) })
    other.release()
    await flush()
    expect(started).toEqual(['normal on c'])
    busy.release()
    await flush()
    await urgent.result
    expect(started).toEqual(['normal on c', 'urgent on a'])
  })

  it('does not let a newcomer take a slot an eligible waiter could have had', async () => {
    const { slots, free } = saturated()
    const started: string[] = []
    queue(slots, started, 'waiting', { rank: work(0) })
    free()
    expect(slots.tryAcquire()).toBeNull()
    await flush()
    expect(started).toEqual(['waiting'])
  })

  it('still takes a cancelled run out of the queue', async () => {
    const { slots, free } = saturated()
    const started: string[] = []
    const cancel = new AbortController()
    const doomed = queue(slots, started, 'urgent', { rank: work(2), signal: cancel.signal })
    queue(slots, started, 'normal', { rank: work(0) })
    cancel.abort()
    await expect(doomed.result).rejects.toBeInstanceOf(RunQueueAbortedError)
    free()
    await flush()
    expect(started).toEqual(['normal'])
  })
})

describe('a person waiting on a turn', () => {
  it('goes ahead of background work that came first, even urgent or aged work', async () => {
    let at = 1_000_000
    const { slots, free } = saturated(1, { now: () => at })
    const started: string[] = []
    queue(slots, started, 'old urgent', { rank: work(2) })
    at += 100 * RUN_QUEUE_AGING_MS
    queue(slots, started, 'chat', { rank: PERSON_TURN })
    free()
    await flush()
    expect(started).toEqual(['chat'])
  })

  it('cannot starve background work: a share of the slots still reaches it', async () => {
    const { slots, free } = saturated()
    const started: string[] = []
    queue(slots, started, 'task', { rank: work(0) })
    const turns = Array.from({ length: PERSON_TURNS_BEFORE_WORK + 1 }, (_, i) => {
      return queue(slots, started, `chat ${i + 1}`, { rank: PERSON_TURN })
    })
    free()
    await flush()
    for (let i = 0; i < PERSON_TURNS_BEFORE_WORK; i++) {
      turns[i]!.slot().release()
      await flush()
    }
    // Every person's turn but the share went first, then the task got its slot.
    expect(started.slice(0, PERSON_TURNS_BEFORE_WORK + 1)).toEqual([
      ...turns.slice(0, PERSON_TURNS_BEFORE_WORK).map((_, i) => `chat ${i + 1}`),
      'task',
    ])
  })

  it('does not spend the share while no background run was waiting', async () => {
    const { slots, free } = saturated()
    const started: string[] = []
    const first = queue(slots, started, 'chat 1', { rank: PERSON_TURN })
    const second = queue(slots, started, 'chat 2', { rank: PERSON_TURN })
    free()
    await flush()
    first.slot().release()
    await flush()
    queue(slots, started, 'task', { rank: work(0) })
    queue(slots, started, 'chat 3', { rank: PERSON_TURN })
    second.slot().release()
    await flush()
    expect(started).toEqual(['chat 1', 'chat 2', 'chat 3'])
  })
})

describe('a paused run in the queue', () => {
  it('does not start when a slot frees, and the next run that can start does', async () => {
    let paused = true
    const { slots, free } = saturated()
    const started: string[] = []
    queue(slots, started, 'paused', { rank: work(2), paused: () => paused })
    queue(slots, started, 'free', { rank: work(0) })
    free()
    await flush()
    expect(started).toEqual(['free'])
    expect(slots.stats().queued).toBe(1)
    paused = false
  })

  it('keeps its place and starts on resume, not before', async () => {
    let paused = true
    const slots = createRunSlots(1)
    const started: string[] = []
    queue(slots, started, 'paused', { paused: () => paused })
    await flush()
    expect(started).toEqual([])
    expect(slots.stats()).toMatchObject({ running: 0, queued: 1 })
    // A slot being free is not a resume.
    slots.resume()
    await flush()
    expect(started).toEqual([])
    paused = false
    slots.resume()
    await flush()
    expect(started).toEqual(['paused'])
  })

  it('takes no free slot through tryAcquire, and leaves it for a run that can use it', () => {
    const slots = createRunSlots(1)
    expect(slots.tryAcquire(null, () => true)).toBeNull()
    expect(slots.tryAcquire(null, () => false)).not.toBeNull()
  })

  it('leaves the queue on a cancel while paused', async () => {
    const slots = createRunSlots(1)
    const cancel = new AbortController()
    const started: string[] = []
    const run = queue(slots, started, 'paused', { paused: () => true, signal: cancel.signal })
    cancel.abort()
    await expect(run.result).rejects.toBeInstanceOf(RunQueueAbortedError)
    expect(slots.stats().queued).toBe(0)
  })

  it('reads a pause it cannot read as paused, and looks again by itself', async () => {
    vi.useFakeTimers()
    try {
      let readable = false
      const slots = createRunSlots(1)
      const started: string[] = []
      queue(slots, started, 'run', {
        paused: () => {
          if (!readable) throw new Error('database is busy')
          return false
        },
      })
      await flush()
      expect(started).toEqual([])
      readable = true
      await vi.advanceTimersByTimeAsync(10_000)
      expect(started).toEqual(['run'])
    } finally {
      vi.useRealTimers()
    }
  })
})
