// The one place a task's agent is woken for what a person did on the board: a question
// answered, a finished task reopened. A saved wake carries it (`task_wakes`, see
// ./taskWakes), so a restart loses nothing, and the pump's own decision says what happens
// next, so a person's first start skips the brake and the failure park as a reply does,
// and anything after that honours them. A run still open on the task, or one held by a
// Stop, leaves the wake waiting rather than moving the card under it.
//
// Saving and starting are apart, because a route saves the wake in the same transaction
// as what the person did, and starts the task only once that has committed.
//
// A task the task runner runs has no ticket block, so its words also go in the mailbox
// (see ./taskSteer). A task waiting on other work is woken inside the board's own write
// instead, because an MCP stdio bin can finish the task it waits on (`releaseWaitersTx`
// in @clawboo/db).

import { delegationTargetOf, type TaskWakeReason, type WakeDecision } from '@clawboo/board-core'
import {
  clearPersonAssignee,
  readTaskRunnerInputs,
  recordTaskWake,
  type ClawbooDb,
  type DbTask,
} from '@clawboo/db'

import { runnerTargetOf } from '../runnerRoute'
import type { ReplyDelivery } from './personReply'
import { forwardPersonCommentToRun } from './taskSteer'
import { pumpTaskWakeNow, type TaskWakePumpDeps } from './taskWakes'

export type PersonWakeReason = Extract<TaskWakeReason, 'question_answered' | 'reopened'>

export interface PersonWakeWords {
  /** Its comment, when this wake is the first to carry it. */
  id?: string
  body: string
}

export type SavedPersonWake =
  { saved: true; agentId: string } | { saved: false; delivery: ReplyDelivery }

export interface SavePersonWakeDeps {
  /** Why nothing could start the task, or null when it can. Asked before anything is
   *  written, so a wake that could never go out is not left waiting. */
  startRefusal?: (task: DbTask) => 'room_archived' | 'no_team' | null
}

/** The agent a person's words go to. A task a person took on has lost its binding, and
 *  is theirs, whatever the runner last ran it with. */
function agentOfTask(task: DbTask): string | null {
  const bound = task.assigneeAgentId ?? delegationTargetOf(task.sourceDelegationId)
  if (bound || task.assigneePersonId) return bound
  return readTaskRunnerInputs(task)?.assigneeAgentId ?? null
}

/** Save the wake, or say why no wake can go. Takes no run. */
export function savePersonWake(
  db: ClawbooDb,
  task: DbTask,
  reason: PersonWakeReason,
  words: PersonWakeWords | null,
  deps: SavePersonWakeDeps = {},
): SavedPersonWake {
  const agentId = agentOfTask(task)
  if (!agentId)
    return {
      saved: false,
      delivery: { status: 'not-delivered', agentId: null, reason: 'unassigned' },
    }
  if (task.status === 'done' || task.status === 'cancelled' || task.dropped)
    return { saved: false, delivery: { status: 'not-delivered', agentId, reason: 'finished' } }
  const refusal = deps.startRefusal?.(task) ?? null
  if (refusal)
    return { saved: false, delivery: { status: 'not-delivered', agentId, reason: refusal } }
  // A hand-back: their words give the turn back to its agent.
  if (task.assigneePersonId) clearPersonAssignee(db, task.id)
  recordTaskWake(db, {
    teamId: task.teamId,
    agentId,
    taskId: task.id,
    reason,
    ...(words?.id ? { commentIds: [words.id] } : {}),
  })
  if (words && runnerTargetOf(db, task)) {
    const forwarded = forwardPersonCommentToRun(
      db,
      { ...task, assigneeAgentId: agentId },
      words.body,
      { mailbox: true, ...(words.id ? { commentId: words.id } : {}) },
    )
    if (!forwarded.forwarded) throw new Error('the mailbox refused a person’s words')
  }
  return { saved: true, agentId }
}

/** Where a person's words went, from what the pump decided. */
function deliveryOf(decision: WakeDecision | null, agentId: string): ReplyDelivery {
  if (!decision) return { status: 'queued', agentId, reason: 'next-run' }
  if (decision.do === 'fire') return { status: 'woke-agent', agentId }
  if (decision.do === 'settle')
    return {
      status: 'not-delivered',
      agentId,
      reason: decision.how === 'finished' ? 'finished' : 'failed',
    }
  switch (decision.skip) {
    case 'held':
      return { status: 'queued', agentId, reason: 'held' }
    case 'paused':
      return { status: 'queued', agentId, reason: 'paused' }
    case 'dependency':
      return { status: 'queued', agentId, reason: 'waiting' }
    case 'under_check':
      return { status: 'queued', agentId, reason: 'in-review' }
    case 'no_agent':
      return { status: 'not-delivered', agentId: null, reason: 'unassigned' }
    case 'room_archived':
    case 'no_team':
      return { status: 'not-delivered', agentId, reason: decision.skip }
    default:
      return { status: 'queued', agentId, reason: 'next-run' }
  }
}

/** Act on a saved wake now. The pump's next pass does the same if this one cannot. */
export function startPersonWake(
  db: ClawbooDb,
  taskId: string,
  agentId: string,
  deps: TaskWakePumpDeps,
): ReplyDelivery {
  return deliveryOf(pumpTaskWakeNow(db, taskId, deps), agentId)
}
