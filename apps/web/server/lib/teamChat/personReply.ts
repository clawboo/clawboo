// A person's reply on a task, delivered to the agent the task belongs to whatever
// its status, and said back to the person so they know where it went.
//
// The agent is the assignee, or the agent the task is bound to while it waits
// (a move back to To do clears the assignee but keeps the binding). A reply is a
// saved wake first (`task_wakes`, see ./taskWakes), so a restart loses nothing and
// replies that come while one waits fold into that one row. Then, by status:
//   - in progress: steered into the run working on it. One it did not take rides the
//     task's next turn, before the task can count as done. A card left in progress
//     with nothing running it is started again instead.
//   - blocked, or waiting in To do: started again, as a person's Retry is, so
//     "the agent asked, I answered" needs no second click. The run reads the
//     reply in its ticket block when it starts.
//   - in review: it waits. The check's answer decides what comes next, and the agent
//     reads it in its next turn, whether that is a fix round or a turn before Done.
//   - backlog: no wake. The person parked the task on purpose, and the agent reads
//     it in the ticket block when the task next runs.
//   - done or cancelled: not delivered. A person reopens it first (the Reopen route
//     takes their comment), or starts a follow-up task for the same agent.
// A reply on a task an agent handed back gives the turn back to that agent.
// While the engine is held, a reply that would start the task waits for the hold to
// lift. A reply that would start the task again is refused instead, before anything
// is written, when nothing could run the task (`startRefusal`), so it never says it
// started a task no engine can see.
//
// A task the task runner runs has no ticket block, so it also gets a mailbox note
// (see ./taskSteer); there, a reply during a run is a note and a steer, as it was.

import { autoFireRefusal, delegationTargetOf } from '@clawboo/board-core'
import {
  addComment,
  clearPersonAssignee,
  getReadyTasks,
  isStrandedInProgress,
  listExecutions,
  recordTaskWake,
  updateStatus,
  type ClawbooDb,
  type DbTask,
} from '@clawboo/db'

import { createLogger } from '@clawboo/logger'

import { emitEvent } from '../obs'
import { runnerTargetOf } from '../runnerRoute'
import { forwardPersonCommentToRun } from './taskSteer'

const log = createLogger('person-reply')

export type ReplyDelivery =
  /** In front of the run working on the task now. */
  | { status: 'steered'; agentId: string }
  /** The task was started again for the reply. */
  | { status: 'woke-agent'; agentId: string }
  /** Waiting for the agent's next turn: a saved wake on a team chat task, a mailbox
   *  note on a task the runner runs. */
  | { status: 'queued'; agentId: string; reason: 'next-run' | 'in-review' | 'waiting' | 'held' }
  | {
      status: 'not-delivered'
      agentId: string | null
      /** `room_archived`: the task is filed under an archived chat room, so
       *  nothing could start it. `no_team`: its room went with its team. */
      reason: 'finished' | 'unassigned' | 'failed' | 'room_archived' | 'no_team'
    }

export interface ReplyDeps {
  /** Starts the task's run (the board's `requestTaskDispatch`). */
  dispatch: (teamId: string, taskId: string) => void
  /** Why the task could not be started for the reply, or null when it can.
   *  Asked before anything is written. */
  startRefusal?: (task: DbTask) => 'room_archived' | 'no_team' | null
  /** Is the engine held (see engineHold)? A start now would be refused. */
  held?: () => boolean
  /** How long to wait for a steer to land before saying it is queued. */
  steerWaitMs?: number
  /** Runs a write the reply causes as part of the person's own write, so it does
   *  not come back to them as news. */
  asOwnWrite?: <T>(write: () => T) => T
}

export async function deliverPersonReply(
  db: ClawbooDb,
  task: DbTask,
  comment: { id: string; body: string },
  deps: ReplyDeps,
): Promise<ReplyDelivery> {
  const agentId = task.assigneeAgentId ?? delegationTargetOf(task.sourceDelegationId)
  if (!agentId) return { status: 'not-delivered', agentId: null, reason: 'unassigned' }
  if (task.status === 'done' || task.status === 'cancelled' || task.dropped) {
    return { status: 'not-delivered', agentId, reason: 'finished' }
  }

  const stranded = isStrandedInProgress(db, task)
  const wakeable = task.status === 'blocked' || task.status === 'todo' || stranded
  if (wakeable && task.teamId) {
    const refusal = deps.startRefusal?.(task) ?? null
    if (refusal) return { status: 'not-delivered', agentId, reason: refusal }
    if (task.assigneePersonId) clearPersonAssignee(db, task.id)
  }
  // A wake is what makes a run come. A parked task waits for a person, and a run the
  // task runner is driving reads its mailbox instead.
  const onRunner = runnerTargetOf(db, task) !== null
  const live = task.status === 'in_progress' && !stranded
  let merged = false
  let wakeId: string | null = null
  if (task.status !== 'backlog' && !(onRunner && live)) {
    try {
      const saved = recordTaskWake(db, {
        teamId: task.teamId,
        agentId,
        taskId: task.id,
        reason: 'person_comment',
        commentIds: [comment.id],
      })
      merged = saved.merged && !saved.startsAfresh
      wakeId = saved.id
    } catch (err) {
      log.error({ err, taskId: task.id }, 'saving a wake for a person comment failed')
      return { status: 'not-delivered', agentId, reason: 'failed' }
    }
  }
  const forward = forwardPersonCommentToRun(
    db,
    { ...task, assigneeAgentId: agentId },
    comment.body,
    {
      ...(wakeId ? { commentId: comment.id } : {}),
      mailbox: onRunner,
    },
  )
  if (!forward.forwarded) return { status: 'not-delivered', agentId, reason: 'failed' }

  if (live) {
    const landed = forward.steer
      ? await Promise.race([
          forward.steer.then((r) => r.delivered),
          new Promise<false>((r) => setTimeout(() => r(false), deps.steerWaitMs ?? 2_500)),
        ])
      : false
    return landed
      ? { status: 'steered', agentId }
      : { status: 'queued', agentId, reason: 'next-run' }
  }
  if (task.status === 'in_review') return { status: 'queued', agentId, reason: 'in-review' }

  if (!wakeable || !task.teamId) return { status: 'queued', agentId, reason: 'next-run' }
  return wake(db, task, task.teamId, agentId, merged, deps)
}

/** Start the task again for the reply, as a person's Retry does. `merged`: the reply
 *  folded into a wake whose run is already on its way. */
function wake(
  db: ClawbooDb,
  task: DbTask,
  teamId: string,
  agentId: string,
  merged: boolean,
  deps: ReplyDeps,
): ReplyDelivery {
  // The saved wake waits: the dispatch pump runs a pass when the hold lifts.
  if (deps.held?.()) return { status: 'queued', agentId, reason: 'held' }
  // Its agent has not finished stopping (it asked, or handed back, and the run is still
  // ending). A move to To do now would read as being taken off the task. The run's end
  // brings the pump, and the wake goes then.
  if (task.status === 'blocked' && autoFireRefusal(listExecutions(db, task.id)) === 'running')
    return { status: 'queued', agentId, reason: 'next-run' }
  if (task.status !== 'todo') {
    const move = (): ReturnType<typeof updateStatus> => updateStatus(db, task.id, 'todo')
    const moved = deps.asOwnWrite ? deps.asOwnWrite(move) : move()
    if (!moved.ok) return { status: 'queued', agentId, reason: 'next-run' }
    emitEvent(db, {
      kind: 'status_changed',
      taskId: task.id,
      teamId,
      data: { to: 'todo', reason: 'reply' },
    })
  }
  // A step still waiting on another task cannot start; the reply waits with it.
  if (!getReadyTasks(db, { teamId }).some((t) => t.id === task.id)) {
    return { status: 'queued', agentId, reason: 'waiting' }
  }
  // A run is already on its way for an earlier reply: it reads this reply too.
  if (merged && task.status === 'todo') return { status: 'woke-agent', agentId }
  addComment(db, task.id, 'Started again for a person’s reply.', 'system', null, { kind: 'note' })
  deps.dispatch(teamId, task.id)
  return { status: 'woke-agent', agentId }
}
