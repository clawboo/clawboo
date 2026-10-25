// A person's comment on a task, passed on to the agent that owns the task.
//
// Two channels:
//   1. The durable mailbox (`agent_inbox`), written first and always. Both run
//      paths (the team engine and the executor runner) read it when a run STARTS,
//      so a queued task, a retried one and the next turn of a running one all see
//      the comment.
//   2. A steer into the run working on the task right now, through the per-task
//      registry every task-running path registers with (see ../runSteers). How it
//      goes in is the runtime's business: live at its next boundary (native,
//      Claude Code, Codex, OpenClaw), or by stopping and resuming the same session
//      with the comment as the next input (Hermes). When the steer lands, the
//      mailbox row is marked delivered so the agent doesn't read it a second time
//      at its next run; when it doesn't, the row is still there.
//
// A finished or cancelled task forwards nothing: no run will read it, and a stale
// mailbox row would land in the agent's next, unrelated turn.

import { enqueueInbox, markInboxDelivered, type ClawbooDb } from '@clawboo/db'
import type { SteerResult } from '@clawboo/executor'
import { createLogger } from '@clawboo/logger'

import { steerTaskRun } from '../runSteers'

const log = createLogger('task-steer')

const MAX_FORWARDED_CHARS = 1_000

export interface SteerableTask {
  id: string
  title: string
  status: string
  teamId: string | null
  assigneeAgentId: string | null
}

export interface ForwardOutcome {
  /** The comment is in the assignee's mailbox. */
  forwarded: boolean
  /** The steer into the running run, when there was one to try. Resolves after
   *  the mailbox row has been marked (or left) accordingly. Never rejects. */
  steer: Promise<SteerResult> | null
}

/** Mailbox + mid-run steer. See the file header. */
export function forwardPersonCommentToRun(
  db: ClawbooDb,
  task: SteerableTask,
  body: string,
): ForwardOutcome {
  const agentId = task.assigneeAgentId
  if (!agentId || task.status === 'done' || task.status === 'cancelled') {
    return { forwarded: false, steer: null }
  }
  const text = `A person commented on your task "${task.title}": ${body.slice(0, MAX_FORWARDED_CHARS)}`
  let rowId: string
  try {
    rowId = enqueueInbox(db, {
      agentId,
      teamId: task.teamId,
      kind: 'alert',
      taskId: task.id,
      body: text,
    }).id
  } catch (err) {
    log.error({ err, taskId: task.id }, 'forwarding a person comment failed')
    return { forwarded: false, steer: null }
  }
  if (task.status !== 'in_progress') return { forwarded: true, steer: null }
  const steer = steerTaskRun(task.id, `[person steering your task] ${text}`)
    .then((result) => {
      if (result.delivered) {
        try {
          markInboxDelivered(db, [rowId], 'signal')
        } catch (err) {
          // The row simply rides the next digest as well.
          log.error({ err, taskId: task.id }, 'marking a steered comment delivered failed')
        }
      } else if (result.reason !== 'no-run') {
        log.info(
          { taskId: task.id, reason: result.reason, detail: result.detail },
          'person comment not steered into the run; the mailbox carries it',
        )
      }
      return result
    })
    .catch((err: unknown): SteerResult => ({
      delivered: false,
      reason: 'rejected',
      detail: err instanceof Error ? err.message : String(err),
    }))
  return { forwarded: true, steer }
}

/** True when the comment was put in the assignee's mailbox. The steer, if any,
 *  runs on in the background. */
export function forwardPersonComment(db: ClawbooDb, task: SteerableTask, body: string): boolean {
  return forwardPersonCommentToRun(db, task, body).forwarded
}
