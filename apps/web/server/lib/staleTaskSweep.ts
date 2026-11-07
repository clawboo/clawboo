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

import {
  reconcileOrphans,
  reconcileStaleInProgress,
  reconcileStaleInReview,
  type ClawbooDb,
  type ParkedReviewsResult,
} from '@clawboo/db'
import { createSuspendDetector } from '@clawboo/executor'

import { emitEvent } from './obs'
import { notifyCheckInterrupted } from './teamChat/inboxNotices'

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

/** Tasks a dead process left In review now wait in Needs you: say so on the event
 *  log (the browser alerts wake on it) and to whoever handed the task out. */
function announceParkedReviews(db: ClawbooDb, parked: ParkedReviewsResult['parked']): void {
  for (const { taskId, teamId, agentId } of parked) {
    emitEvent(db, {
      kind: 'status_changed',
      taskId,
      teamId,
      agentId,
      data: { to: 'blocked', reason: 'check_interrupted' },
    })
    notifyCheckInterrupted(db, taskId, teamId)
  }
}

/** The boot reap of runs whose process is gone; returns how many it closed. */
export function reapOrphanedRuns(db: ClawbooDb, staleAfterMs: number): number {
  const { reconciled, parked } = reconcileOrphans(db, { staleAfterMs })
  announceParkedReviews(db, parked)
  return reconciled
}

/** One pass over rows older than `olderThanMs`, for {@link StaleTaskSweepOptions.reconcile}:
 *  a run with no beat goes back to To do, or, when its work was being checked, to a
 *  person. Returns how many tasks it moved. */
export function sweepStaleRuns(db: ClawbooDb, olderThanMs: number): number {
  const released = reconcileStaleInProgress(db, olderThanMs).reconciled
  const { reconciled, parked } = reconcileStaleInReview(db, olderThanMs)
  announceParkedReviews(db, parked)
  return released + reconciled
}
