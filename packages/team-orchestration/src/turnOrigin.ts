// Why a run is happening — stamped by whoever asks for it, never inferred.
//
// THE BUG THIS REPLACES. `serverDeliver` decided whether a turn was the
// user-facing leader turn or a delegated worker turn from ONE boolean,
// `taskForSession(sessionKey) != null`. That map is correct while a delegation is
// in flight and wrong the moment it ends: `completeForSession` calls
// `forgetSession` on the worker's terminal, so every LATER delivery to that same
// session — a late `[Task Update]` from a sub-task that reports back to it, an
// alert naming it, a peer signal — read as "no task, therefore the leader". The
// ex-worker was then handed the leader coordination block telling it to run the
// team, plus `[About the User]`, the user's personal intro that exists precisely
// to be withheld from agents that are not talking to the user.
//
// The 60s `RECENTLY_TERMINATED_TTL_MS` guard does not cover this. It stops a stale
// terminal from spawning work; it does not stop a genuinely NEW turn arriving
// after it expires, and such a turn delegating with `sourceTaskId = null` opens a
// fresh depth-0 subtree from what is really a leaf.
//
// WHY A TYPE AND NOT A BETTER HEURISTIC. Every heuristic here guesses at something
// the caller already knows for certain. The engine knows it is firing a
// delegation; the chat route knows a human typed; the reflection batcher knows it
// is neither. Passing that fact costs one argument and makes the classification
// impossible to get wrong by timing.

import type { TaskWakeReason } from '@clawboo/board-core'

/** The person's message a turn answers: what the turn's first hand-off makes a main
 *  task from (see `createHandOff`). A plain answer leaves it unused. */
export interface TurnRequest {
  /** Their words, whole. */
  words: string
  /** Who asked: the verified person, the built-in one, or null for a routine. */
  requestedBy?: { id: string; name: string | null; role: string | null } | null
  /** The routine that posted it, when one did. */
  routineName?: string
}

/** The reason a turn is being delivered. */
export type TurnOrigin =
  /** A human typed into team chat — the leader, or a specialist they @mentioned. */
  | { kind: 'human'; request?: TurnRequest }
  /** A peer delegated this task. `fromAgentId` is the delegator (the reduce point
   *  its result reports to), or null when the engine could not attribute one. */
  | { kind: 'delegation'; fromAgentId: string | null }
  /** A person assigned this board task to the agent directly (the board's New
   *  task dialog, an explicit assignment, a retry). Its result is posted on the
   *  task card for that person; no teammate is waiting on it. */
  | { kind: 'assignment' }
  /** Something happened on the task and its agent is being woken for it: a saved
   *  wake (see `task_wakes`). A task run like the two above. `reason` says why,
   *  `wakeIds` names the rows it carries, settled when this run ends, and
   *  `fromAgentId` is who the result reports to. `assigned`, present only when
   *  true: a person assigned the task, so its report stays on the card. `inChat`,
   *  present only when true: this is the team lead's follow-up on its own task, and
   *  its summary reaches the chat as well as the card. */
  | {
      kind: 'wake'
      reason: TaskWakeReason
      wakeIds: string[]
      fromAgentId: string | null
      assigned?: true
      inChat?: true
    }
  /** Clawboo itself: a batched `[Task Update]` (the reflection batcher is the
   *  only producer). No human is waiting on the other end of this turn.
   *
   *  `forTaskId`, present only when set, marks a FOLLOW-UP: the recipient
   *  delegated this work while running that task, which has since closed. Its
   *  reply is a report on that task for whoever gave it the task, not a message
   *  to the user. The engine never sets it for the team lead.
   *
   *  `reportUpIds`, present only when set, names the durable report-ups this
   *  update carries. The host copies them onto the run's stamp, and the engine
   *  settles them when that run ends.
   *
   *  `mainTaskId`, present only when set, says which person's request this update
   *  is about: what the recipient hands out goes under it, and when all its work is
   *  in, the reply is the summary that closes it. Never with `forTaskId`. */
  | { kind: 'system'; forTaskId?: string; reportUpIds?: string[]; mainTaskId?: string }
  /** A routine the person scheduled posted this into team chat on their behalf.
   *  It carries their words, so it frames like a human turn, but nobody is
   *  necessarily watching when it runs. */
  | { kind: 'schedule'; routineName: string; request?: TurnRequest }

/** Convenience singletons: these variants carry no payload. */
export const HUMAN_TURN: TurnOrigin = { kind: 'human' }
export const SYSTEM_TURN: TurnOrigin = { kind: 'system' }
export const ASSIGNMENT_TURN: TurnOrigin = { kind: 'assignment' }

/** What a turn IS, decided once and read by everything that frames it. */
export interface TurnFraming {
  /** Executing a board task delegated to it. Gets the worker guardrail. */
  isWorker: boolean
  /** Present, and true, when a PERSON assigned this task (not a teammate's
   *  delegation). Its report goes on the task card rather than back to the team
   *  lead. Absent on every other turn. */
  isUserAssigned?: boolean
  /** The team's reduce point, on a turn where it is not itself a worker. Gets the
   *  leader coordination block. */
  isLeader: boolean
  /** This turn's output reaches the human. Gates `[About the User]`. */
  isUserFacing: boolean
  /** Present when a scheduled routine sent this turn: the routine's name. The
   *  person may be away, so the turn is framed to finish without waiting on
   *  them. Absent on every other turn (and on a worker, whose guardrail wins). */
  scheduledRoutine?: string
  /** Present only on a follow-up (a system origin with `forTaskId`, delivered to
   *  an agent that is not the team lead): that task's id. The reply is recorded
   *  on that task and never shown in chat. */
  reportsForTask?: string
}

/**
 * Classify a turn.
 *
 * The three questions were previously one boolean, which is why they could not all
 * be answered correctly at once:
 *
 *   • **worker** — is it executing a delegated board task? The origin says so
 *     directly; `hasBoardTask` is kept as the second witness so a re-fire of an
 *     already-claimed task (stamped `system`) is still framed as work.
 *   • **leader** — is this agent the team's reduce point? A property of WHO it is,
 *     not of what the session map currently remembers. This is the fix.
 *   • **user-facing** — can this turn's reply reach the human? True when a human
 *     addressed it (including an @mentioned specialist, which used to be told it
 *     was the team lead) and true for the leader, whose synthesis of a reflection
 *     is written for the user even though clawboo triggered it. A scheduled
 *     routine counts as the human addressing it: the message is their own.
 *
 * A follow-up (a system origin carrying `forTaskId`, to anyone but the lead) is
 * none of the three: it reports on a closed task to whoever gave it, even when
 * it is queued behind the agent's own task run and `hasBoardTask` is true.
 */
export function classifyTurn(input: {
  origin: TurnOrigin
  targetAgentId: string
  leaderAgentId: string | null
  hasBoardTask: boolean
}): TurnFraming {
  const reportFor =
    input.origin.kind === 'system' &&
    input.origin.forTaskId &&
    input.targetAgentId !== input.leaderAgentId
      ? input.origin.forTaskId
      : null
  const isUserAssigned =
    input.origin.kind === 'assignment' || (input.origin.kind === 'wake' && !!input.origin.assigned)
  // The team lead's follow-up on its own task reaches the chat. It is the lead speaking for
  // the team, as for a `[Task Update]`, not a worker whose reply goes to someone else.
  const leadInChat =
    input.origin.kind === 'wake' &&
    input.origin.inChat === true &&
    input.targetAgentId === input.leaderAgentId
  const isWorker =
    reportFor === null &&
    !leadInChat &&
    (input.origin.kind === 'delegation' ||
      input.origin.kind === 'wake' ||
      isUserAssigned ||
      input.hasBoardTask)
  const isLeader =
    !isWorker && input.leaderAgentId !== null && input.targetAgentId === input.leaderAgentId
  const fromThePerson = input.origin.kind === 'human' || input.origin.kind === 'schedule'
  // A worker is NEVER user-facing, even on a human-origin turn: the user can
  // @mention a specialist mid-task, and framing that turn with both the worker
  // guardrail ("you CANNOT reach the user") and [About the User] is a
  // contradiction handed to the model. The guardrail wins; the message itself
  // still arrives as content. A person-assigned task is a worker turn too: its
  // report is read on the card, but nobody can answer a question mid-task.
  return {
    isWorker,
    ...(isUserAssigned ? { isUserAssigned: true } : {}),
    isLeader,
    isUserFacing: (fromThePerson && !isWorker) || isLeader,
    ...(input.origin.kind === 'schedule' && !isWorker
      ? { scheduledRoutine: input.origin.routineName }
      : {}),
    ...(reportFor !== null ? { reportsForTask: reportFor } : {}),
  }
}

/** What a run was delivered as, fixed at delivery and handed back to the engine
 *  with each of its events. `reportForTaskId` is the framing's `reportsForTask`,
 *  or null. `stopGen` is the host's stop generation at delivery. `reportUpIds`
 *  is a system origin's `reportUpIds`: the durable report-ups this run carries, plus
 *  any a Stop held for this agent's next run. `execId`, on a task run: the execution
 *  stamped on the task's claim, so a terminal from a run the task has moved on from
 *  is not taken for the task's. `wakeIds`: the saved wakes this run carries. */
export interface RunStamp {
  reportForTaskId: string | null
  stopGen: number
  reportUpIds?: string[]
  /**
   * This one delivery, unique for good. An event's `runId` cannot serve: Codex binds
   * it to the native thread and Hermes' quiet transport to the session key, so every
   * turn of a resumed session carries the same one.
   */
  deliveryId?: string
  execId?: string
  wakeIds?: string[]
  /** A pause stopped this run. It is no failure, and what it carried comes back. */
  stoppedByPause?: boolean
  /** A person's or a routine's message: `TurnOrigin.request`. */
  request?: TurnRequest
  /** An update about one request: `TurnOrigin.mainTaskId`. */
  mainTaskId?: string
}

/**
 * May this turn's reply reach the team chat? Decided from why the turn was
 * delivered, never from whether the session happens to map a task when it runs.
 *
 * Must never be derived from `isUserFacing`: a person's @mention to a worker
 * that holds a task is framed as a worker turn, but it is still a reply they
 * asked for.
 */
export function isChatVisible(
  origin: TurnOrigin,
  framing: Pick<TurnFraming, 'reportsForTask'>,
): boolean {
  switch (origin.kind) {
    case 'human':
    case 'schedule':
      return true
    case 'system':
      return framing.reportsForTask === undefined
    case 'wake':
      return origin.inChat === true
    case 'delegation':
    case 'assignment':
      return false
  }
}
