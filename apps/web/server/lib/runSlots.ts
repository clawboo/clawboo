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
//
// A HELD ENGINE (see engineHold) grants no slot at all, however many are free:
// every run start waits in the same queue, in the same order, and nothing else
// changes for it. Runs holding a slot are untouched. When the hold lifts, the
// queue hands out free slots as if they had just been released.

import { createLogger } from '@clawboo/logger'

import { engineHold } from './engineHold'

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
   * {@link RunQueueAbortedError} if `signal` aborts before the slot is granted,
   * including a signal that had already aborted, even when a slot is free. A slot
   * granted just as the signal fires still resolves: the caller owns it and must
   * release it.
   */
  acquire(request?: RunSlotRequest): Promise<RunSlot>
  stats(): RunSlotStats
  /** Hand free slots to waiting runs. The engine hold calls it when it lifts. */
  resume(): void
}

export interface RunSlotsOptions {
  /** True while the engine is held: no slot is granted, free or not. Never held by default. */
  held?: () => boolean
}

interface Waiter {
  key: string | null
  grant: (slot: RunSlot) => void
}

/** A first-come counting semaphore of `size` run slots, at most one per key. */
export function createRunSlots(size: number, options: RunSlotsOptions = {}): RunSlots {
  if (!Number.isInteger(size) || size < 1) {
    throw new RangeError(`run slots: size must be a whole number of at least 1, got ${size}`)
  }
  const engineHeld = options.held ?? ((): boolean => false)
  let running = 0
  /** Keys a slot holder has now. */
  const heldKeys = new Set<string>()
  // Invariant: while a slot is free and the engine is not held, every waiter's
  // key is held, so a run that can start right now never jumps one that could
  // have started before it.
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
    if (engineHeld()) return
    while (running < size) {
      const at = waiters.findIndex((w) => keyFree(w.key))
      if (at === -1) return
      const [next] = waiters.splice(at, 1)
      next!.grant(take(next!.key))
    }
  }

  const tryAcquire = (key: string | null = null): RunSlot | null => {
    if (engineHeld()) return null
    // A hold can lapse between two reads with runs still queued behind it: they
    // go first, which restores the invariant.
    grantWaiting()
    return running < size && keyFree(key) ? take(key) : null
  }

  return {
    size,
    tryAcquire,
    acquire(request) {
      const key = request?.key ?? null
      const signal = request?.signal ?? null
      // Before a free slot is taken: a run cancelled before it asked never starts.
      if (signal?.aborted) return Promise.reject(new RunQueueAbortedError())
      const now = tryAcquire(key)
      if (now) return Promise.resolve(now)
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
        const isHeld = engineHeld()
        log.info(
          { running, queued: waiters.length, size, agentBusy: !keyFree(key), engineHeld: isHeld },
          isHeld
            ? 'the run waits: the engine is held and starts no new run'
            : 'the run waits for a free run slot',
        )
      })
    },
    stats: () => ({ size, running, queued: waiters.length }),
    resume: grantWaiting,
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
let stopFollowingHold: (() => void) | null = null

/**
 * The process's run slots, sized from the environment on first use. They follow
 * the engine hold: held, they grant nothing; when it lifts, the queue resumes.
 */
export function runSlots(): RunSlots {
  if (!shared) {
    const slots = createRunSlots(maxConcurrentRunsFromEnv(), {
      held: () => engineHold().isHeld(),
    })
    stopFollowingHold = engineHold().onResume(() => slots.resume())
    shared = slots
  }
  return shared
}

/** TEST-ONLY: swap the process's run slots; null rebuilds them from the env on next use. */
export function setRunSlotsForTests(slots: RunSlots | null): void {
  stopFollowingHold?.()
  stopFollowingHold = null
  shared = slots
}

export interface WaitForRunsOptions {
  /** Stop waiting after this long, runs or not. */
  timeoutMs: number
  /** Stop waiting at once (a forced stop). */
  signal?: AbortSignal
  /** Called with the number of runs holding a slot, first at once and then each time it changes. */
  onRunning?: (running: number) => void
  /** How often to look. Defaults to 500 ms. */
  pollMs?: number
}

export interface WaitForRunsResult {
  /** Runs still holding a slot when the wait ended: 0 unless it timed out or was cut short. */
  running: number
  timedOut: boolean
}

/**
 * Wait until no run holds one of the process's slots. What a drain waits for:
 * hold the engine first, or new runs keep taking slots as old ones finish. Runs
 * waiting in the queue are not waited for; while the engine is held they never
 * start.
 */
export async function waitForRunsToFinish(opts: WaitForRunsOptions): Promise<WaitForRunsResult> {
  const pollMs = opts.pollMs ?? 500
  const deadline = Date.now() + opts.timeoutMs
  let last = -1
  for (;;) {
    const { running } = runSlots().stats()
    if (running !== last) {
      last = running
      opts.onRunning?.(running)
    }
    if (running === 0) return { running: 0, timedOut: false }
    if (opts.signal?.aborted) return { running, timedOut: false }
    const left = deadline - Date.now()
    if (left <= 0) return { running, timedOut: true }
    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer)
        opts.signal?.removeEventListener('abort', done)
        resolve()
      }
      const timer = setTimeout(done, Math.min(pollMs, left))
      opts.signal?.addEventListener('abort', done, { once: true })
    })
  }
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
