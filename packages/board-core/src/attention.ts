// ─── Needs-you classification ───────────────────────────────────────────────
// Which tasks are waiting on a PERSON, and why. A task needs you when nothing on
// the board will move it forward by itself:
//
//   · it is `blocked`: a run failed or went silent, verification could not pass
//     it, or an agent marked it blocked;
//   · it is `todo` but the dispatcher will never fire it: no agent is bound to
//     it, the user stopped its last run, or it failed MAX_AUTO_FIRES times in a
//     row and was parked;
//   · it is `in_progress` with no agent on it and no run going: moved there by
//     hand, which starts nothing, so it would sit there looking worked on.
//
// Everything else (queued work the pump will fire, a run in flight, a finished
// or cancelled task, a deliberately parked backlog item) returns null.
//
// Pure and import-free apart from the sibling dispatch rules, so the server that
// computes it and the board UI that renders it agree by construction.

import {
  accountFailureOf,
  delegationTargetOf,
  ledgerWillAutoFire,
  trailingFailedRuns,
  type AccountFailure,
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
  /** In progress with no agent and no run: nothing is working on it. */
  | 'unstarted'

export interface TaskAttention {
  reason: AttentionReason
  /** Consecutive unsuccessful runs at the tail of the ledger (0 when none). */
  failedRuns: number
  /** What the last run said when it failed, trimmed for a card. Present only for
   *  a failed or timed-out run that recorded one. */
  detail?: string
  /** The last run failed because the provider refused the account: a person has
   *  to fix its sign-in or billing before a retry can work. */
  cause?: AccountFailure
  /** The runtime whose sign-in to fix. Present only with `cause`. */
  runtime?: string
  /** For `blocked`: a person moved the card there and no run has started
   *  since, so it waits on their own decision rather than an agent's. */
  byPerson?: boolean
}

/** Longest failure reason a card shows; the full text stays on the task. */
const DETAIL_MAX = 280

function failureDetail(
  execs: readonly LedgerRun[],
): Pick<TaskAttention, 'detail' | 'cause' | 'runtime'> {
  const last = execs.length > 0 ? execs[execs.length - 1]! : undefined
  const trimmed = typeof last?.error === 'string' ? last.error.trim() : ''
  const cause = accountFailureOf(last)
  const runtime = last?.runtime || last?.executorType || null
  return {
    ...(trimmed
      ? {
          detail: trimmed.length > DETAIL_MAX ? `${trimmed.slice(0, DETAIL_MAX - 1)}…` : trimmed,
        }
      : {}),
    ...(cause ? { cause, ...(runtime ? { runtime } : {}) } : {}),
  }
}

export interface AttentionInput {
  status: string
  /** The task's `sourceDelegationId` (where its bound agent is recorded). */
  sourceDelegationId?: string | null
  /** The execution ledger, oldest run first. */
  execs: readonly LedgerRun[]
  /** Verification returned a verdict that cannot be promoted to done. */
  verificationBlocked?: boolean
  /** The agent working on it, for an in-progress task. */
  assigneeAgentId?: string | null
  /** When a person last moved the card (`personMovedAt`). */
  personMovedAt?: number | null
}

/** When the latest run started: its start, else its claim, else its creation. */
function latestRunStart(execs: readonly LedgerRun[]): number | null {
  let latest: number | null = null
  for (const e of execs) {
    const at = e.startedAt ?? e.claimedAt ?? e.createdAt ?? null
    if (typeof at === 'number' && (latest === null || at > latest)) latest = at
  }
  return latest
}

/** The same test the repository uses to refuse an agent's status write after a
 *  person's move: the move came after the latest run started, or nothing ran. */
function movedByPerson(input: AttentionInput): boolean {
  const moved = input.personMovedAt
  if (typeof moved !== 'number') return false
  const lastRun = latestRunStart(input.execs)
  return lastRun === null || moved > lastRun
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
    return { reason: 'blocked', failedRuns, ...(movedByPerson(input) ? { byPerson: true } : {}) }
  }

  if (input.status === 'todo') {
    if (!delegationTargetOf(input.sourceDelegationId))
      return { reason: 'unassigned', failedRuns: 0 }
    // A live run owns it (a release racing a run's terminal): not stuck.
    if (last === 'running') return null
    if (last === 'cancelled') return { reason: 'stopped', failedRuns: 0 }
    // A task the no-progress brake is holding back fires by itself when the wait
    // ends, so it does not need a person.
    if (!ledgerWillAutoFire(input.execs)) {
      return {
        reason: last === 'timed_out' ? 'timed_out' : 'failed',
        failedRuns,
        ...failureDetail(input.execs),
      }
    }
    return null
  }

  if (input.status === 'in_progress' && !input.assigneeAgentId && last !== 'running') {
    return { reason: 'unstarted', failedRuns: 0 }
  }

  return null
}
