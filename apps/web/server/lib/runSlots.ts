// The process-wide cap on agent runs executing at once.
//
// Every run start (a board task, a team chat turn, a one-to-one chat turn, a
// peer-exchange turn, an OpenClaw Routine run) takes one of these slots before
// its adapter starts and gives it back when the run ends, however it ends. A run
// that finds every slot taken waits in a first-come queue; waiting is never a
// failure, and only its caller's own cancellation (a Stop, a disconnect, a person
// moving the card) takes it out of the queue.
//
// LOCK ORDER (load-bearing): a run takes its slot FIRST and its agent's lock
// (`homeDispatchMutex`, `connectedAgentMutex`, the one-to-one chat lock) second.
// A run waiting for a slot then holds nothing another run needs. The reverse order
// deadlocks: a lead's run, holding a slot, waits for its delegate to start; the
// delegate waits for its agent's lock; and that lock's holder, another run of the
// same agent, waits for a slot that only the lead can free.
//
// A run names that lock as its `key`, and the queue never gives a slot to a run
// whose key a slot holder already has. Runs of one busy agent run one at a time on
// their lock anyway, so without this the ones queued behind it would sit on slots
// doing nothing, and one agent's backlog could take the whole cap.
//
// The cap is per process. `CLAWBOO_MAX_CONCURRENT_RUNS` sets it once, at first use.

import { createLogger } from '@clawboo/logger'

const log = createLogger('run-slots')

/** Agent runs allowed at once when `CLAWBOO_MAX_CONCURRENT_RUNS` is unset. */
export const DEFAULT_MAX_CONCURRENT_RUNS = 8

/** `acquire` rejects with this when its signal aborts while the run is still queued. */
export class RunQueueAbortedError extends Error {
  constructor() {
    super('The run was cancelled while it waited for a free run slot.')
    this.name = 'RunQueueAbortedError'
  }
}

/** A held slot. `release` may be called any number of times; only the first counts. */
export interface RunSlot {
  release(): void
}

export interface RunSlotStats {
  /** The cap. */
  size: number
  /** Slots held now. */
  running: number
  /** Runs waiting for a slot. */
  queued: number
}

export interface RunSlotRequest {
  /** The agent lock the run takes once it has its slot; null or absent for a run
   *  that takes none. Two runs with one key never hold slots at the same time. */
  key?: string | null
  /** Aborting it takes a queued run out of the queue. */
  signal?: AbortSignal | null
}

export interface RunSlots {
  readonly size: number
  /** A slot now, or null when every slot is taken or a run with `key` holds one. */
  tryAcquire(key?: string | null): RunSlot | null
  /**
   * A slot as soon as one is free for this run, oldest waiter first. Rejects with
   * {@link RunQueueAbortedError} if `signal` aborts before the slot is granted. A
   * slot granted just as the signal fires still resolves: the caller owns it and
   * must release it.
   */
  acquire(request?: RunSlotRequest): Promise<RunSlot>
  stats(): RunSlotStats
}

interface Waiter {
  key: string | null
  grant: (slot: RunSlot) => void
}

/** A first-come counting semaphore of `size` run slots, at most one per key. */
export function createRunSlots(size: number): RunSlots {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`run slots: size must be a whole number of at least 1, got ${size}`)
  }
  let running = 0
  /** Keys a slot holder has now. */
  const heldKeys = new Set<string>()
  // Invariant: while a slot is free, every waiter's key is held, so a run that
  // can start right now never jumps one that could have started before it.
  const waiters: Waiter[] = []

  const keyFree = (key: string | null): boolean => key === null || !heldKeys.has(key)

  const take = (key: string | null): RunSlot => {
    running++
    if (key !== null) heldKeys.add(key)
    let held = true
    return {
      release(): void {
        if (!held) return
        held = false
        running--
        if (key !== null) heldKeys.delete(key)
        grantWaiting()
      },
    }
  }

  /** Give free slots to the oldest waiters whose key no slot holder has. */
  const grantWaiting = (): void => {
    while (running < size) {
      const at = waiters.findIndex((w) => keyFree(w.key))
      if (at === -1) return
      const [next] = waiters.splice(at, 1)
      next!.grant(take(next!.key))
    }
  }

  const tryAcquire = (key: string | null = null): RunSlot | null =>
    running < size && keyFree(key) ? take(key) : null

  return {
    size,
    tryAcquire,
    acquire(request) {
      const key = request?.key ?? null
      const now = tryAcquire(key)
      if (now) return Promise.resolve(now)
      const signal = request?.signal ?? null
      if (signal?.aborted) return Promise.reject(new RunQueueAbortedError())
      return new Promise<RunSlot>((resolve, reject) => {
        const waiter: Waiter = {
          key,
          grant: (slot) => {
            signal?.removeEventListener('abort', onAbort)
            resolve(slot)
          },
        }
        const onAbort = (): void => {
          const at = waiters.indexOf(waiter)
          if (at === -1) return // already granted; the caller releases it
          waiters.splice(at, 1)
          reject(new RunQueueAbortedError())
        }
        signal?.addEventListener('abort', onAbort, { once: true })
        waiters.push(waiter)
        log.info(
          { running, queued: waiters.length, size, agentBusy: !keyFree(key) },
          'the run waits for a free run slot',
        )
      })
    },
    stats: () => ({ size, running, queued: waiters.length }),
  }
}

/**
 * The cap from `CLAWBOO_MAX_CONCURRENT_RUNS`: a whole number of at least 1.
 * Unset or empty means the default; any other value is logged and means the
 * default too, so a typo never turns the cap off.
 */
export function maxConcurrentRunsFromEnv(
  raw: string | undefined = process.env['CLAWBOO_MAX_CONCURRENT_RUNS'],
): number {
  if (raw === undefined || raw.trim() === '') return DEFAULT_MAX_CONCURRENT_RUNS
  const n = Number(raw)
  if (Number.isInteger(n) && n >= 1) return n
  log.warn(
    { value: raw, using: DEFAULT_MAX_CONCURRENT_RUNS },
    'CLAWBOO_MAX_CONCURRENT_RUNS must be a whole number of at least 1; using the default',
  )
  return DEFAULT_MAX_CONCURRENT_RUNS
}

let shared: RunSlots | null = null

/** The process's run slots, sized from the environment on first use. */
export function runSlots(): RunSlots {
  if (!shared) shared = createRunSlots(maxConcurrentRunsFromEnv())
  return shared
}

/** TEST-ONLY: swap the process's run slots; null rebuilds them from the env on next use. */
export function setRunSlotsForTests(slots: RunSlots | null): void {
  shared = slots
}

/**
 * Run `fn` holding one of the process's run slots, released however `fn` ends.
 * Rejects with {@link RunQueueAbortedError} (without calling `fn`) when `signal`
 * aborts while the run is queued.
 */
export async function withRunSlot<T>(fn: () => Promise<T>, request?: RunSlotRequest): Promise<T> {
  const slot = await runSlots().acquire(request)
  try {
    return await fn()
  } finally {
    slot.release()
  }
}
