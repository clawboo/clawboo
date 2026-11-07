// ─── Needs-you classification ───────────────────────────────────────────────
// Which tasks are waiting on a PERSON, and why. A task needs you when nothing on
// the board will move it forward by itself:
//
//   · it is `blocked`: a run failed or went silent, verification could not pass
//     it, or an agent marked it blocked;
//   · it is `todo` but the dispatcher will never fire it: no agent is bound to
//     it, the user stopped its last run, a budget cap or the circuit breaker stopped
//     it, or it failed too many times in a row and was parked;
//   · it is `in_progress` with no agent on it and no run going: moved there by
//     hand, which starts nothing, so it would sit there looking worked on;
//   · it waits on a person (`waiting_on`), which includes a question an agent
//     asked, or it is assigned to a person;
//   · a teammate's comment would start it, and a person has to say whether agents may
//     wake each other on this job, or they have been pausing and it is theirs to lift;
//   · it is the top of a job that has started all the runs it may by itself, and work
//     under it waits for a person to say carry on.
//
// A task waiting on another task or on its own sub-tasks is not on this list: the
// board moves it on when that work finishes.
//
// Everything else (queued work the pump will fire, a run in flight, a finished
// or cancelled task, a deliberately parked backlog item) returns null.
//
// Pure and import-free apart from the sibling dispatch rules, so the server that
// computes it and the board UI that renders it agree by construction.

import { teammateMayEndWait, type AgentWakeCard } from './agentWakes'
import {
  accountFailureOf,
  BREAKER_TRIPPED_STATUS,
  BUDGET_HELD_STATUS,
  budgetRefusalOf,
  delegationTargetOf,
  ledgerWillAutoFire,
  trailingFailedRuns,
  stoppedByPause,
  type AccountFailure,
  type LedgerRun,
} from './dispatch'
import { parseWaitingOn, waitsOnOtherWork } from './waitingOn'

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
  /** An agent asked a person a question and waits for the answer. */
  | 'question'
  /** It is assigned to a person: their turn. */
  | 'assigned'
  /** A person is asked whether agents may wake each other on this job, or has to lift a
   *  pause in those wakes. The task's own wait is untouched. */
  | 'agent_wakes'
  /** The job this task heads has started all the runs it may by itself. Work waits, and
   *  a person says to carry on or stop. */
  | 'job_limit'
  /** Its agent finished twice with nothing to show for it. */
  | 'no_result'
  /** The provider kept rate limiting it, and the automatic retries are used up. */
  | 'rate_limited'
  /** The provider stayed overloaded or out of reach, and the retries are used up. */
  | 'provider_down'
  /** Its agent ran out of room twice. */
  | 'out_of_room'
  /** A hard budget cap stopped it. */
  | 'budget'
  /** The circuit breaker stopped it. */
  | 'breaker'

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
  /** For `question`: the question waiting for its answer. */
  questionId?: string
  /** For `assigned`: the person whose turn it is. */
  personId?: string
  /** For `assigned`: an agent handed the task back, as opposed to a person taking
   *  it themselves. Only the first is news to anyone. */
  handedBack?: boolean
  /** For `agent_wakes`: the card and what it is about. */
  agentWakes?: AgentWakeCard
  /** For `job_limit`: the job and how far it has gone. */
  jobLimit?: JobLimitCard
}

/** What the job limit's card carries, on the attention of the task that heads the job. */
export interface JobLimitCard {
  jobTaskId: string
  /** Runs it has started by itself. */
  runs: number
  /** Where it stops now. */
  limit: number
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
  /** The task runner saved how to run it, so it can start it again with no agent bound. */
  runnerBound?: boolean
  /** What the task waits on: the `waiting_on` column, or its parsed value. */
  waitingOn?: unknown
  /** The person it is assigned to. */
  assigneePersonId?: string | null
  /** The card on this task, if the job has one open here. */
  agentWakes?: AgentWakeCard | null
  /** This task heads a job stopped at its limit, with work waiting. */
  jobLimit?: JobLimitCard | null
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
  const lastRun = input.execs.length > 0 ? input.execs[input.execs.length - 1]! : undefined
  const last = lastRun?.status ?? null
  const waiting = parseWaitingOn(input.waitingOn)
  const open = input.status !== 'done' && input.status !== 'cancelled'

  // Nothing automatic starts anywhere under this task until a person answers, whatever
  // state the task itself is in: it may even have finished, with work it handed out still
  // going. Ahead of everything, because every other reason on it can wait behind this one.
  if (input.jobLimit) return { reason: 'job_limit', failedRuns, jobLimit: input.jobLimit }

  // Whose turn it is comes before what the ledger says: a question is waiting
  // whatever the last run did, and a person's task is theirs whatever came before.
  if (open && waiting?.kind === 'question')
    return { reason: 'question', failedRuns, questionId: waiting.questionId }
  if (open && input.status !== 'backlog' && input.assigneePersonId) {
    const need = waiting?.kind === 'person' ? waiting : null
    return {
      reason: 'assigned',
      failedRuns: 0,
      personId: input.assigneePersonId,
      ...(need ? { detail: need.need } : {}),
      ...(need?.by === 'agent' ? { handedBack: true } : {}),
    }
  }
  // Only for a wait a teammate's comment could end, so a card left over from before can
  // never stand in front of a failure and the Retry it comes with.
  if (input.status === 'blocked' && input.agentWakes && teammateMayEndWait(waiting))
    return { reason: 'agent_wakes', failedRuns, agentWakes: input.agentWakes }
  // A check that could not be parked: In progress or In review to the board, but
  // nothing is coming for it until a person looks or the move lands.
  if (open && waiting?.kind === 'verification' && waiting.state === 'park_pending')
    return { reason: 'needs_review', failedRuns }

  if (input.status === 'blocked') {
    if (waitsOnOtherWork(waiting)) return null
    // What it waits on now, ahead of a check that failed before it: the fix round that
    // came next is what ended this way, and Retry is what gets it going.
    if (waiting?.kind === 'no_result') return { reason: 'no_result', failedRuns }
    if (waiting?.kind === 'out_of_room')
      return { reason: 'out_of_room', failedRuns, ...failureDetail(input.execs) }
    if (waiting?.kind === 'provider')
      return {
        reason: waiting.cause === 'rate_limited' ? 'rate_limited' : 'provider_down',
        failedRuns,
        ...failureDetail(input.execs),
      }
    // Its error column holds machine words, and a card's comment says the rest.
    if (waiting?.kind === 'budget') return { reason: 'budget', failedRuns }
    if (input.verificationBlocked) return { reason: 'needs_review', failedRuns }
    // The agent said what a person must do, and its run failed afterwards. What they
    // must do is still the next step.
    if (waiting?.kind === 'person' && waiting.by === 'agent')
      return { reason: 'blocked', failedRuns, detail: waiting.need }
    if (budgetRefusalOf(lastRun)) return { reason: 'budget', failedRuns }
    if (waiting?.kind === 'breaker' || last === BREAKER_TRIPPED_STATUS)
      return { reason: 'breaker', failedRuns }
    if (last === 'timed_out')
      return { reason: 'timed_out', failedRuns, ...failureDetail(input.execs) }
    if (last === 'failed') return { reason: 'failed', failedRuns, ...failureDetail(input.execs) }
    if (waiting?.kind === 'verification') return { reason: 'needs_review', failedRuns }
    // A person's own move has no need to read back to them.
    const need =
      waiting?.kind === 'person' && waiting.by !== 'person' ? { detail: waiting.need } : {}
    return {
      reason: 'blocked',
      failedRuns,
      ...need,
      ...(movedByPerson(input) ? { byPerson: true } : {}),
    }
  }

  // An agent moved its task In review and says a person must act.
  if (input.status === 'in_review' && waiting?.kind === 'person')
    return { reason: 'needs_review', failedRuns, detail: waiting.need }

  if (input.status === 'todo') {
    // A pause stopped it: it waits for the resume, which a person already knows
    // about, and fires again by itself. The card shows who paused it. That takes an
    // agent to fire it for: its binding, or what the task runner saved.
    const pauseStopped = stoppedByPause(input.execs[input.execs.length - 1])
    if (!delegationTargetOf(input.sourceDelegationId) && !(pauseStopped && input.runnerBound))
      return { reason: 'unassigned', failedRuns: 0 }
    // A live run owns it (a release racing a run's terminal): not stuck.
    if (last === 'running') return null
    if (pauseStopped) return null
    if (budgetRefusalOf(lastRun) && last !== BUDGET_HELD_STATUS)
      return { reason: 'budget', failedRuns }
    if (last === BREAKER_TRIPPED_STATUS) return { reason: 'breaker', failedRuns }
    if (last === 'cancelled') return { reason: 'stopped', failedRuns: 0 }
    // A task the no-progress brake or a wait is holding back fires by itself when the
    // wait ends, so it does not need a person.
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
