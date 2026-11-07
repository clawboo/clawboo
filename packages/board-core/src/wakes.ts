// ─── Wake rules ─────────────────────────────────────────────────────────────
// What may wake a task's agent, and what the pump does with a saved wake. A wake
// is a durable row (`task_wakes`, see @clawboo/db taskWakes.ts): something happened
// on a task, and its agent has not heard. These are the decisions over that row,
// import-free apart from the sibling dispatch rules, like the state machine.

import type { AgentWakeVerdict } from './agentWakes'
import { autoFireRefusal, type LedgerRun } from './dispatch'

/** Why a task's agent is being woken. */
export type TaskWakeReason =
  /** A person's comment: one the dashboard's own page sent. */
  | 'person_comment'
  /** A task it was waiting on moved to done, on any path. */
  | 'dependency_done'
  /** A person answered its question. */
  | 'question_answered'
  /** A person reopened a finished task. */
  | 'reopened'
  /** A teammate's comment, through a Tasks session bound to that agent. A person has
   *  to allow these once per job: see ./agentWakes. */
  | 'agent_comment'
  /** All the work it handed out has closed: its follow-up turn. */
  | 'subtasks_closed'

/** Why a run on a task started, written to its `execution_processes.run_reason`
 *  and read back by the ticket block's "Why this run" line. */
export type TaskRunReason =
  | TaskWakeReason
  | 'delegation'
  | 'assignment'
  | 'fix_round'
  /** Its last run ended with nothing to show for it: one more turn to say what it did. */
  | 'empty_reply'
  /** Its last run ran out of room: one continuation. */
  | 'max_turns'
  /** Its last run hit a provider failure, and this is the automatic retry. */
  | 'provider_retry'
  /** A person asked for this run (Retry, or Run now). */
  | 'person_retry'

/**
 * What wrote a comment, set by the writer and never read from `authorType`: Retry
 * and Assign write their notes as `user` comments, the reply path writes a
 * `system` note, and REST accepts `agent` and `system` from any caller.
 *  • `person` a person, through the dashboard's own page;
 *  • `agent`  an agent, through a Tasks session bound to it;
 *  • `note`   clawboo, about the task;
 *  • `result` the engine, recording a run's result.
 * Null (a REST caller naming itself, a row from before this column) never wakes.
 */
export type CommentKind = 'person' | 'agent' | 'note' | 'result'

/**
 * May this comment wake the task's agent? The one place that decides. A person's
 * always may. An agent's may only where a person has not said no (`agentWakes`), and
 * whether it goes yet is the pump's to decide, once it would really start the task.
 * An @-mention is text.
 */
export function commentMayWake(
  comment: { kind?: string | null; authorType?: string },
  opts: { agentWakes?: boolean } = {},
): boolean {
  if (comment.kind === 'person') return true
  return comment.kind === 'agent' && opts.agentWakes === true
}

/** Is a person behind this wake? Their first start skips the no-progress brake and
 *  the automatic pump's other refusals, and restarts a Blocked task. */
export function wakeFromPerson(reason: string): boolean {
  return reason === 'person_comment' || reason === 'question_answered' || reason === 'reopened'
}

/** How much a reason outranks: a person, then the board's own, then a teammate's, which
 *  alone has to wait for a person's yes and must not hold the others back. */
const wakeRank = (reason: string): number =>
  wakeFromPerson(reason) ? 2 : reason === 'agent_comment' ? 0 : 1

/** The reason a merged row keeps: the one that outranks, else the first. */
export function strongerWakeReason<R extends string>(a: R, b: R): R {
  return wakeRank(b) > wakeRank(a) ? b : a
}

/** Why a saved wake is still waiting. Each names what ends the wait. */
export type WakeSkipReason =
  /** The engine is held (stop, update): ends when the hold lifts. */
  | 'held'
  /** A pause covers its agent, team or task tree: ends when a person resumes it. */
  | 'paused'
  /** Its team is archived: ends when a person brings the team back. */
  | 'team_archived'
  /** A hard budget cap would refuse the run: ends when a person raises it. */
  | 'budget'
  /** The no-progress brake: ends when its wait runs out, or at a person's comment. */
  | 'braked'
  /** A provider failure's retry wait: ends by itself, or at a person's comment. */
  | 'retry_wait'
  /** The circuit breaker stopped it: a person retries it. */
  | 'breaker'
  /** The agent's session is on other work: ends when it frees up. */
  | 'agent_busy'
  /** A run proven alive holds the task, which also covers a run waiting for a
   *  slot and a fix round about to go out. It takes the wake when it renders its
   *  context, or at its next turn. */
  | 'run_live'
  /** A run is on the ledger but nothing proves it alive. The stale sweep ends it, on a
   *  task In progress, Blocked or back in To do alike. */
  | 'run_unproven'
  /** In progress with no run behind it. A person moves the card or retries it. */
  | 'no_run'
  /** A work check is under way: the check's answer decides what comes next. */
  | 'under_check'
  /** A dependency is unfinished. */
  | 'dependency'
  /** It failed MAX_AUTO_FIRES times in a row: a person retries it. */
  | 'parked'
  /** A person stopped it: a person retries it. */
  | 'stopped'
  /** The runtime's sign-in was refused: a person fixes it, then retries. */
  | 'sign_in'
  /** The provider refused the account's billing: a person fixes it, then retries. */
  | 'billing'
  /** Blocked, and this wake is not one a person is behind. */
  | 'blocked'
  /** A person holds it: ends when they give it back to its agent. */
  | 'person_assigned'
  /** It waits on a person's answer: ends when they answer, comment, or move it on. */
  | 'question'
  /** A teammate's comment would start it, and a person has not said yes for this job:
   *  ends at their answer on the card. */
  | 'ask_once'
  /** The job's agents woke each other too often this hour: ends when the hour is over,
   *  or when a person lets them carry on. */
  | 'hourly_cap'
  /** Two agents keep waking each other, or three or more in a ring: ends when a person
   *  lets them carry on, or comments on the job. Never by itself. */
  | 'back_and_forth'
  /** The job has started as many runs by itself as it may: ends when a person says to
   *  carry on. */
  | 'job_limit'
  /** A person stopped the job at that limit: ends when a person starts work in it. */
  | 'job_stopped'
  /** A person parked it in Backlog. */
  | 'backlog'
  /** No agent is bound to it: a person assigns one. */
  | 'no_agent'
  /** Filed under an archived room that the move at boot has not picked up. */
  | 'room_archived'
  /** Its room went with its team: nothing can run it, and the row is reaped. */
  | 'no_team'

/** Every skip reason, for a reader that must name each one. */
export const WAKE_SKIP_REASONS: readonly WakeSkipReason[] = [
  'held',
  'paused',
  'team_archived',
  'budget',
  'braked',
  'retry_wait',
  'breaker',
  'agent_busy',
  'run_live',
  'run_unproven',
  'no_run',
  'under_check',
  'dependency',
  'parked',
  'stopped',
  'sign_in',
  'billing',
  'blocked',
  'person_assigned',
  'question',
  'ask_once',
  'hourly_cap',
  'back_and_forth',
  'job_limit',
  'job_stopped',
  'backlog',
  'no_agent',
  'room_archived',
  'no_team',
]

/** How a saved wake was closed. `merged`: folded into another row that was waiting.
 *  `declined`: a person said agents do not wake each other on this job. */
export type TaskWakeSettlement =
  'delivered' | 'stopped' | 'gave_up' | 'finished' | 'merged' | 'declined'

/** Times a wake is sent again because the run carrying it did not finish. Past
 *  this it is given up, with an alert. */
export const MAX_TASK_WAKE_REPLAYS = 3

export interface WakeDecisionInput {
  reason: string
  /** Times it was sent again after a run that did not finish. */
  replays: number
  status: string
  dropped: boolean
  /** An agent is bound to the task or assigned to it. */
  hasAgent: boolean
  /** Every dependency is done. */
  ready: boolean
  /** The task's ledger, oldest run first. */
  execs: readonly LedgerRun[]
  /** The task is stamped with a running execution whose beat is fresh. */
  runProvenAlive: boolean
  /** The engine is held. */
  held: boolean
  /** A pause covers it. Read like the hold, so a person's comment cannot waive it. */
  paused: boolean
  /** Why nothing can run it, or null. */
  refusal: 'room_archived' | 'no_team' | 'team_archived' | null
  /** A hard budget cap would refuse a run now. */
  budgetRefused: boolean
  /** The job has started all the runs it may by itself. Only a person's first start goes
   *  past it. */
  jobLimited?: boolean
  /** That is because a person stopped the job, and no card is up to answer. */
  jobStopped?: boolean
  /** A person holds the task. No wake starts it: it is their turn. */
  personAssigned?: boolean
  /** It waits on a question still open, so a comment from before the agent asked
   *  does not end that wait. A person's reply does, through its own path, or here when
   *  a pause, a hold or a run still ending put it off: the host then says false. */
  waitingOnQuestion?: boolean
  /** A Blocked task: is the wait one a teammate's comment could end? */
  teammateMayEndWait?: boolean
  /** A teammate's comment: what the job's decision and brakes say. */
  agentWakes?: AgentWakeVerdict
  now: number
}

export type WakeDecision =
  | {
      do: 'fire'
      /** The automatic pump's policy is waived: a person is behind it, or a raised budget
       *  cap has let the task go again. */
      force: boolean
      /** A person is behind this start, so it neither counts toward the job's limit nor is
       *  refused by it. A cap raised is not: that start is the run's own. */
      byPerson: boolean
      /** The task is Blocked and goes back to To do first. */
      moveToTodo: boolean
    }
  | { do: 'settle'; how: 'finished' | 'gave_up' | 'declined' }
  | { do: 'wait'; skip: WakeSkipReason }

const wait = (skip: WakeSkipReason): WakeDecision => ({ do: 'wait', skip })

/**
 * What the pump does with a saved wake, decided fresh each pass from what the board
 * says now. Every `wait` names a skip reason, and every skip reason has a way out
 * (see {@link WakeSkipReason}): no wake sits waiting with nothing that can end it.
 */
export function wakeDecision(input: WakeDecisionInput): WakeDecision {
  const { status } = input
  if (input.dropped || status === 'done' || status === 'cancelled')
    return { do: 'settle', how: 'finished' }
  if (input.replays >= MAX_TASK_WAKE_REPLAYS) return { do: 'settle', how: 'gave_up' }
  const teammate = input.reason === 'agent_comment'
  if (teammate && input.agentWakes === 'no') return { do: 'settle', how: 'declined' }
  if (input.held) return wait('held')
  if (input.paused) return wait('paused')
  if (input.refusal) return wait(input.refusal)
  if (!input.hasAgent) return wait('no_agent')
  if (input.personAssigned) return wait('person_assigned')
  if (input.waitingOnQuestion) return wait('question')
  if (status === 'backlog') return wait('backlog')
  if (status === 'in_review') return wait('under_check')
  if (status === 'in_progress') {
    if (input.runProvenAlive) return wait('run_live')
    return wait(input.execs.at(-1)?.status === 'running' ? 'run_unproven' : 'no_run')
  }
  const fromPerson = wakeFromPerson(input.reason)
  if (status === 'blocked' && !fromPerson && !(teammate && input.teammateMayEndWait))
    return wait('blocked')
  if (!input.ready) return wait('dependency')
  if (input.budgetRefused) return wait('budget')
  // A person's first start waives what guards the AUTOMATIC pump. What it cannot
  // waive: a run still on the ledger, and an account refusal that would fail the
  // same way. A replay is automatic again: it honours all of them.
  const first = fromPerson && input.replays === 0
  if (input.jobLimited && !first) return wait(input.jobStopped ? 'job_stopped' : 'job_limit')
  const refusal = autoFireRefusal(input.execs, input.now)
  if (refusal === 'running') return wait('run_unproven')
  if (refusal === 'sign_in' || refusal === 'billing') return wait(refusal)
  // The last run was refused by a budget and the gate above says it would not be
  // now: the cap was raised, or the room was freed, so the wake goes out, past the
  // ledger's old reading.
  const capRaised = refusal === 'budget' || refusal === 'budget_held'
  if (!first && !capRaised) {
    if (refusal === 'braked') return wait('braked')
    if (refusal === 'retry_wait') return wait('retry_wait')
    if (refusal === 'breaker') return wait('breaker')
    if (refusal === 'stopped') return wait('stopped')
    if (refusal === 'failed_too_often') return wait('parked')
  }
  // Asked last, so a person is asked only about a wake that would really start now. A
  // task in To do starts by itself, so nothing about it is a wake to ask about.
  if (teammate && status === 'blocked') {
    if (input.agentWakes === 'ask') return wait('ask_once')
    if (input.agentWakes === 'hourly_cap' || input.agentWakes === 'back_and_forth')
      return wait(input.agentWakes)
  }
  return {
    do: 'fire',
    force: first || capRaised,
    byPerson: first,
    moveToTodo: status === 'blocked',
  }
}
