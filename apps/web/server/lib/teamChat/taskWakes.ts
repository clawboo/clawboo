// The server's half of a saved wake (`task_wakes`, see @clawboo/db taskWakes.ts): the
// engine's view of its room's rows, and the pump that decides what each waiting row
// does now. The decision is @clawboo/board-core's `wakeDecision`; this reads what it
// needs, acts on the answer, and leaves a visible reason when the answer is to wait.
//
// The room is read when the wake fires, never stored: archiving a room moves its
// tasks to the team's own chat.

import {
  delegationTargetOf,
  parseWaitingOn,
  wakeDecision,
  type WakeDecision,
  type WakeDecisionInput,
  wakeFromPerson,
  type WakeSkipReason,
} from '@clawboo/board-core'
import {
  addComment,
  getAncestors,
  getTask,
  holdTaskWakes,
  listExecutions,
  listTaskWakesCarriedBy,
  listUndeliveredInbox,
  listUnsettledTaskWakes,
  listWaitingTaskWakes,
  markInboxDelivered,
  noteTaskWakeSkip,
  readTaskRunnerInputs,
  reapTaskWakes,
  settleTaskWakes,
  TASK_HEARTBEAT_MS,
  taskDependenciesDone,
  updateStatus,
  wakeCommentIds,
  type ClawbooDb,
  type DbTask,
  type DbTaskWake,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import type { TaskWakeOutbox } from '@clawboo/team-orchestration'

import { reserveRunBudget } from '../budgetHold'
import { emitEvent } from '../obs'
import { runnerTargetOf } from '../runnerRoute'
import { engineRefusal, roomIdForTask } from './roomRoster'

const log = createLogger('task-wakes')

/** A beat older than this proves nothing: the stale sweep is about to read the same
 *  silence as a dead run. */
const RUN_PROVEN_ALIVE_MS = 6 * TASK_HEARTBEAT_MS

/** Record why a row waits, and say so once for each reason. */
function noteSkip(db: ClawbooDb, row: DbTaskWake, reason: WakeSkipReason): void {
  if (!noteTaskWakeSkip(db, row.id, reason)) return
  emitEvent(db, {
    kind: 'task_wake_skipped',
    taskId: row.taskId,
    teamId: row.teamId,
    agentId: row.agentId,
    data: { wakeId: row.id, reason, wakeReason: row.reason },
  })
}

/** The engine's view of the wakes on one chat room's tasks. */
export function createTaskWakeOutbox(
  db: ClawbooDb,
  teamId: string,
  roomId: string | null,
): TaskWakeOutbox {
  return {
    fromPersonWaiting(taskId) {
      try {
        return listWaitingTaskWakes(db, { taskId })
          .filter((row) => wakeFromPerson(row.reason))
          .map((row) => ({ id: row.id, commentIds: wakeCommentIds(row) }))
      } catch (err) {
        log.error({ err, taskId }, 'reading the wakes on a task failed')
        return []
      }
    },
    settle(ids, how) {
      try {
        settleTaskWakes(db, ids, how)
        return true
      } catch (err) {
        log.error({ err, teamId, roomId, how }, 'task wake settle failed')
        return false
      }
    },
    settleCarriedBy(execId) {
      try {
        settleTaskWakes(
          db,
          listTaskWakesCarriedBy(db, execId).map((row) => row.id),
          'delivered',
        )
        return true
      } catch (err) {
        log.error({ err, teamId, roomId, execId }, 'settling a run’s task wakes failed')
        return false
      }
    },
    holdAll() {
      try {
        // Filed under this room, or driven from it now: a room being archived no longer
        // reads as active, and its tasks have not moved yet.
        const inRoom = (taskId: string): boolean =>
          roomIdForTask(db, taskId) === roomId || (getTask(db, taskId)?.roomId ?? null) === roomId
        holdTaskWakes(
          db,
          listUnsettledTaskWakes(db, teamId)
            .filter((row) => inRoom(row.taskId))
            .map((row) => row.id),
        )
        return true
      } catch (err) {
        log.error({ err, teamId, roomId }, 'task wake hold failed')
        return false
      }
    },
    noteSkip(taskId, reason) {
      try {
        for (const row of listWaitingTaskWakes(db, { taskId })) noteSkip(db, row, reason)
      } catch (err) {
        log.error({ err, taskId, reason }, 'noting a skipped task wake failed')
      }
    },
  }
}

export interface TaskWakePumpDeps {
  /** Is the engine held (see engineHold)? */
  held: () => boolean
  /** Start a task for a wake a person is behind, the way their Retry would. */
  startForPerson: (task: DbTask, agentId: string) => void
  /** Pump the room's engine: an automatic start goes through its fire policy. */
  pumpRoom: (teamId: string, roomId: string | null) => void
  /** Tell the team's chat a wake was given up. False when it could not be written,
   *  so the row stays and the next pass tries again. */
  alert: (alert: {
    teamId: string
    roomId: string | null
    agentId: string
    text: string
  }) => boolean
  /** Would a hard budget cap refuse a run of this task now? Asked of a wake about to
   *  go out, before anything on the card moves. */
  budgetRefuses?: (task: DbTask, agentId: string) => boolean
  /** Runs the move it makes as part of a person's own write: see `runOwnWrite`. */
  asOwnWrite?: <T>(write: () => T) => T
  now?: () => number
}

/** The note on a card a wake moved back to To do, by what is behind the wake. */
const STARTED_AGAIN: Partial<Record<string, string>> = {
  question_answered: 'Started again with a person’s answer.',
}
const STARTED_AGAIN_FOR_REPLY = 'Started again for a person’s reply.'

/** Ask the budget gate, taking nothing: a hold it grants is released at once. */
function budgetGateRefuses(db: ClawbooDb, task: DbTask, agentId: string): boolean {
  try {
    const root = getAncestors(db, task.id).find((a) => a.parent_task_id == null)?.id ?? task.id
    const gate = reserveRunBudget(
      db,
      { agentId, missionId: root, teamId: task.teamId },
      { kind: 'team-chat', ref: `wake:${task.id}` },
    )
    if (gate.blocked) return true
    gate.hold.release()
    return false
  } catch (err) {
    // Unread, as at a run's own gate: the run goes, and its own gate decides.
    log.error({ err, taskId: task.id }, 'budget gate could not be asked for a wake')
    return false
  }
}

/** The task finished before the wake could go out. Nothing can run it now, so the
 *  person who wrote the comment is told, and the agent's next run is not. */
function settleFinished(db: ClawbooDb, task: DbTask | null, row: DbTaskWake): void {
  settleTaskWakes(db, [row.id], 'finished')
  emitEvent(db, {
    kind: 'task_wake_skipped',
    taskId: row.taskId,
    teamId: row.teamId,
    agentId: row.agentId,
    data: { wakeId: row.id, reason: 'finished', wakeReason: row.reason },
  })
  if (!task || wakeCommentIds(row).length === 0) return
  // A mailbox row for it would otherwise land in the agent's next, unrelated run.
  const stale = listUndeliveredInbox(db, row.agentId, { teamId: row.teamId, limit: 50 })
    .filter((m) => m.taskId === task.id)
    .map((m) => m.id)
  if (stale.length > 0) markInboxDelivered(db, stale, 'signal')
  // A task the runner runs reads its comments from the mailbox: with none left
  // waiting there, its agent did read this one.
  if (runnerTargetOf(db, task) !== null && stale.length === 0) return
  addComment(
    db,
    task.id,
    'This task finished before its agent read the comment above, so no one acted on it. Start a follow-up task if it still matters.',
    'system',
    null,
    { kind: 'note' },
  )
}

/**
 * One pass over every waiting wake. Called by the dispatch pump (so a restart is a
 * pause and a held engine leaves a reason), and within seconds of anything that may
 * free one. Each row is decided on its own, so one failure leaves the rest to go.
 */
export function pumpTaskWakes(db: ClawbooDb, deps: TaskWakePumpDeps): void {
  reapTaskWakes(db)
  const now = deps.now?.() ?? Date.now()
  const held = deps.held()
  for (const row of listWaitingTaskWakes(db, { includeHeld: true })) {
    try {
      pumpOne(db, row, deps, held, now)
    } catch (err) {
      log.error({ err, wakeId: row.id, taskId: row.taskId }, 'pumping a task wake failed')
    }
  }
}

/**
 * The same decision for one task's waiting wake, right now, for a person waiting to
 * hear where their words went. Null when no wake waits on it any more: a run took it.
 */
export function pumpTaskWakeNow(
  db: ClawbooDb,
  taskId: string,
  deps: TaskWakePumpDeps,
): WakeDecision | null {
  const row = listWaitingTaskWakes(db, { taskId })[0]
  if (!row) return null
  return pumpOne(db, row, deps, deps.held(), deps.now?.() ?? Date.now())
}

function pumpOne(
  db: ClawbooDb,
  row: DbTaskWake,
  deps: TaskWakePumpDeps,
  held: boolean,
  now: number,
): WakeDecision {
  const task = getTask(db, row.taskId)
  if (!task) {
    settleTaskWakes(db, [row.id], 'finished')
    return { do: 'settle', how: 'finished' }
  }
  const execs = listExecutions(db, task.id)
  const runner = runnerTargetOf(db, task)
  const agentId =
    task.assigneeAgentId ??
    delegationTargetOf(task.sourceDelegationId) ??
    readTaskRunnerInputs(task)?.assigneeAgentId ??
    null
  const input: WakeDecisionInput = {
    reason: row.reason,
    replays: row.replays,
    status: task.status,
    dropped: !!task.dropped,
    hasAgent: agentId !== null,
    ready: taskDependenciesDone(db, task.id),
    execs,
    runProvenAlive:
      task.runExecutionId !== null &&
      execs.some((e) => e.id === task.runExecutionId && e.status === 'running') &&
      now - task.updatedAt < RUN_PROVEN_ALIVE_MS,
    held,
    refusal: runner ? null : task.teamId ? engineRefusal(db, task) : 'no_team',
    budgetRefused: false,
    personAssigned: task.assigneePersonId !== null,
    waitingOnQuestion: parseWaitingOn(task.waitingOn)?.kind === 'question',
    now,
  }
  let decision = wakeDecision(input)
  // A run the gate would refuse must not move the card or leave a note. It may have
  // no ledger row saying so yet: the task runner refuses before its claim. A raised
  // cap lets it through on the next pass.
  if (
    decision.do === 'fire' &&
    row.heldAt === null &&
    agentId !== null &&
    (deps.budgetRefuses ?? ((t, a) => budgetGateRefuses(db, t, a)))(task, agentId)
  )
    decision = wakeDecision({ ...input, budgetRefused: true })
  // A row a Stop held starts nothing. A task that closed still closes it: it can
  // never ride a next run.
  if (row.heldAt !== null) {
    if (decision.do === 'settle' && decision.how === 'finished') settleFinished(db, task, row)
    return decision
  }
  if (decision.do === 'wait') {
    noteSkip(db, row, decision.skip)
    return decision
  }
  if (decision.do === 'settle') {
    if (decision.how === 'finished') {
      settleFinished(db, task, row)
      return decision
    }
    giveUp(db, task, row, agentId, deps)
    return decision
  }
  if (!agentId) return decision
  if (decision.moveToTodo) {
    const move = (): boolean => {
      const moved = updateStatus(db, task.id, 'todo')
      if (!moved.ok) return false
      addComment(
        db,
        task.id,
        STARTED_AGAIN[row.reason] ?? STARTED_AGAIN_FOR_REPLY,
        'system',
        null,
        { kind: 'note' },
      )
      return true
    }
    if (!(deps.asOwnWrite ? deps.asOwnWrite(move) : move())) return decision
    emitEvent(db, {
      kind: 'status_changed',
      taskId: task.id,
      teamId: task.teamId,
      data: { to: 'todo', reason: 'wake' },
    })
  }
  if (decision.force) {
    deps.startForPerson(getTask(db, task.id) ?? task, agentId)
    return decision
  }
  // A task the runner runs is started by the same pass of the runner's own pump.
  if (!runner && task.teamId) deps.pumpRoom(task.teamId, roomIdForTask(db, task.id))
  return decision
}

function giveUp(
  db: ClawbooDb,
  task: DbTask,
  row: DbTaskWake,
  agentId: string | null,
  deps: TaskWakePumpDeps,
): void {
  const text = `A wake on “${task.title}” could not be delivered after ${row.replays} more tries. Its comments and results are on the task.`
  if (agentId && task.teamId) {
    const told = deps.alert({
      teamId: task.teamId,
      roomId: roomIdForTask(db, task.id),
      agentId,
      text,
    })
    if (!told) return
  }
  settleTaskWakes(db, [row.id], 'gave_up')
  emitEvent(db, {
    kind: 'task_wake_given_up',
    taskId: task.id,
    teamId: task.teamId,
    agentId,
    data: { wakeId: row.id, wakeReason: row.reason, replays: row.replays },
  })
}
