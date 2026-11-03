// One pass of the board's stale-task sweep, kept apart from the boot code so its
// handling of a machine that slept can be tested.
//
// The sweep releases an `in_progress` task whose drain stopped heartbeating
// (`reconcileStaleInProgress`). A drain beats every 30 s on a timer, so a row
// older than the TTL normally means a dead drain. After a sleep that is no
// longer true: every row still carries its last beat from before the lid closed,
// and a pass that runs before the drains beat again would release live work.
// So for one TTL after a wake the sweep adds the slept time to the TTL, which
// judges each row by the time the process was awake since its last beat. Within
// that TTL every live drain has beaten again, and the normal cutoff resumes.

import { createSuspendDetector } from '@clawboo/executor'

export interface StaleTaskSweepOptions {
  /** A row this long without a beat (of awake time) is released. */
  ttlMs: number
  /** How often the host runs the pass. */
  intervalMs: number
  /** One release pass over rows older than `olderThanMs`; returns how many it released. */
  reconcile: (olderThanMs: number) => number
  /** Injectable clock (tests). Defaults to `Date.now`. */
  now?: () => number
}

/** Build the sweep's pass. Call it every `intervalMs`, starting at boot; it
 *  returns how many tasks it released. */
export function createStaleTaskSweep(opts: StaleTaskSweepOptions): () => number {
  const now = opts.now ?? (() => Date.now())
  const suspendedFor = createSuspendDetector(opts.intervalMs)
  let credit = 0
  let creditUntil = 0
  return () => {
    const at = now()
    const slept = suspendedFor(at)
    if (slept > 0) {
      // A sleep that began inside the window adds to the one before it: a row
      // from before both missed both.
      credit = (at - slept < creditUntil ? credit : 0) + slept
      creditUntil = at + opts.ttlMs
    }
    return opts.reconcile(opts.ttlMs + (at < creditUntil ? credit : 0))
  }
}
