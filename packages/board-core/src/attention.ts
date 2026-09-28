// ─── Needs-you classification ───────────────────────────────────────────────
// Which tasks are waiting on a PERSON, and why. A task needs you when nothing on
// the board will move it forward by itself:
//
//   · it is `blocked`: a run failed or went silent, verification could not pass
//     it, or an agent marked it blocked;
//   · it is `todo` but the dispatcher will never fire it: no agent is bound to
//     it, the user stopped its last run, or it failed MAX_AUTO_FIRES times in a
//     row and was parked.
//
// Everything else (queued work the pump will fire, a run in flight, a finished
// or cancelled task, a deliberately parked backlog item) returns null.
//
// Pure and import-free apart from the sibling dispatch rules, so the server that
// computes it and the board UI that renders it agree by construction.

import {
  delegationTargetOf,
  ledgerAllowsAutoFire,
  trailingFailedRuns,
  type LedgerRun,
} from './dispatch'

export type AttentionReason =
  /** The last run ended in an error (a crash, a runtime error, an infra kill). */
  | 'failed'
  /** The last run stopped responding and the watchdog ended it. */
  | 'timed_out'
  /** The user pressed Stop on its last run; it will not restart on its own. */
  | 'stopped'
  /** Verification returned a verdict that cannot be promoted to done. */
  | 'needs_review'
  /** Marked blocked for a reason the ledger does not explain (an agent's call). */
  | 'blocked'
  /** No agent is bound to it, so no one will pick it up. */
  | 'unassigned'

export interface TaskAttention {
  reason: AttentionReason
  /** Consecutive unsuccessful runs at the tail of the ledger (0 when none). */
  failedRuns: number
  /** What the last run said when it failed, trimmed for a card. Present only for
   *  a failed or timed-out run that recorded one. */
  detail?: string
}

/** Longest failure reason a card shows; the full text stays on the task. */
const DETAIL_MAX = 280

function failureDetail(execs: readonly LedgerRun[]): { detail?: string } {
  const error = execs.length > 0 ? execs[execs.length - 1]!.error : null
  const trimmed = typeof error === 'string' ? error.trim() : ''
  if (!trimmed) return {}
  return { detail: trimmed.length > DETAIL_MAX ? `${trimmed.slice(0, DETAIL_MAX - 1)}…` : trimmed }
}

export interface AttentionInput {
  status: string
  /** The task's `sourceDelegationId` (where its bound agent is recorded). */
  sourceDelegationId?: string | null
  /** The execution ledger, oldest run first. */
  execs: readonly LedgerRun[]
  /** Verification returned a verdict that cannot be promoted to done. */
  verificationBlocked?: boolean
}

/** Why a task needs a person, or null when the board will move it on its own. */
export function taskAttention(input: AttentionInput): TaskAttention | null {
  const failedRuns = trailingFailedRuns(input.execs)
  const last = input.execs.length > 0 ? input.execs[input.execs.length - 1]!.status : null

  if (input.status === 'blocked') {
    if (input.verificationBlocked) return { reason: 'needs_review', failedRuns }
    if (last === 'timed_out')
      return { reason: 'timed_out', failedRuns, ...failureDetail(input.execs) }
    if (last === 'failed') return { reason: 'failed', failedRuns, ...failureDetail(input.execs) }
    return { reason: 'blocked', failedRuns }
  }

  if (input.status === 'todo') {
    if (!delegationTargetOf(input.sourceDelegationId))
      return { reason: 'unassigned', failedRuns: 0 }
    // A live run owns it (a release racing a run's terminal): not stuck.
    if (last === 'running') return null
    if (last === 'cancelled') return { reason: 'stopped', failedRuns: 0 }
    if (!ledgerAllowsAutoFire(input.execs)) {
      return {
        reason: last === 'timed_out' ? 'timed_out' : 'failed',
        failedRuns,
        ...failureDetail(input.execs),
      }
    }
    return null
  }

  return null
}
