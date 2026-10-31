// A person's reply on a task, delivered to the agent the task belongs to whatever
// its status, and said back to the person so they know where it went.
//
// The agent is the assignee, or the agent the task is bound to while it waits
// (a move back to To do clears the assignee but keeps the binding). Every reply
// goes into that agent's mailbox first (see ./taskSteer); then, by status:
//   - in progress: steered into the run working on it. A card left in progress
//     with nothing running it is started again instead.
//   - blocked, or waiting in To do: started again, as a person's Retry is, so
//     "the agent asked, I answered" needs no second click. The run reads the
//     reply from the mailbox when it starts. Replies that come within a few
//     seconds of each other start one run, not one each.
//   - in review: it waits in the mailbox; the agent reads it after the check.
//   - backlog: it waits in the mailbox; the person parked the task on purpose.
//   - done or cancelled: not delivered. The task cannot reopen, so the person is
//     offered a follow-up task for the same agent instead.

import { delegationTargetOf } from '@clawboo/board-core'
import {
  addComment,
  getReadyTasks,
  isStrandedInProgress,
  updateStatus,
  type ClawbooDb,
  type DbTask,
} from '@clawboo/db'

import { emitEvent } from '../obs'
import { forwardPersonCommentToRun } from './taskSteer'

export type ReplyDelivery =
  /** In front of the run working on the task now. */
  | { status: 'steered'; agentId: string }
  /** The task was started again for the reply. */
  | { status: 'woke-agent'; agentId: string }
  /** In the agent's mailbox, read when the task next runs. */
  | { status: 'queued'; agentId: string; reason: 'next-run' | 'in-review' | 'waiting' }
  | {
      status: 'not-delivered'
      agentId: string | null
      reason: 'finished' | 'unassigned' | 'failed'
    }

export interface ReplyDeps {
  /** Starts the task's run (the board's `requestTaskDispatch`). */
  dispatch: (teamId: string, taskId: string) => void
  /** How long to wait for a steer to land before saying it is queued. */
  steerWaitMs?: number
  now?: () => number
}

/** Replies this close together start one run. */
const FOLD_MS = 15_000
const lastWake = new Map<string, number>()

/** Test helper: forget the fold window. */
export function resetReplyWakes(): void {
  lastWake.clear()
}

export async function deliverPersonReply(
  db: ClawbooDb,
  task: DbTask,
  body: string,
  deps: ReplyDeps,
): Promise<ReplyDelivery> {
  const agentId = task.assigneeAgentId ?? delegationTargetOf(task.sourceDelegationId)
  if (!agentId) return { status: 'not-delivered', agentId: null, reason: 'unassigned' }
  if (task.status === 'done' || task.status === 'cancelled' || task.dropped) {
    return { status: 'not-delivered', agentId, reason: 'finished' }
  }

  const stranded = isStrandedInProgress(db, task)
  const forward = forwardPersonCommentToRun(db, { ...task, assigneeAgentId: agentId }, body)
  if (!forward.forwarded) return { status: 'not-delivered', agentId, reason: 'failed' }

  if (task.status === 'in_progress' && !stranded) {
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

  const wakeable = task.status === 'blocked' || task.status === 'todo' || stranded
  if (!wakeable || !task.teamId) return { status: 'queued', agentId, reason: 'next-run' }
  return wake(db, task, task.teamId, agentId, deps)
}

/** Start the task again for the reply, as a person's Retry does. */
function wake(
  db: ClawbooDb,
  task: DbTask,
  teamId: string,
  agentId: string,
  deps: ReplyDeps,
): ReplyDelivery {
  const now = deps.now?.() ?? Date.now()
  const last = lastWake.get(task.id)
  if (task.status === 'todo' && last != null && now - last < FOLD_MS) {
    // A run is already on its way for an earlier reply; it reads this one too.
    return { status: 'woke-agent', agentId }
  }
  if (task.status !== 'todo') {
    const moved = updateStatus(db, task.id, 'todo')
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
  lastWake.set(task.id, now)
  addComment(db, task.id, 'Started again for a person’s reply.', 'system')
  deps.dispatch(teamId, task.id)
  return { status: 'woke-agent', agentId }
}
