// A person's comment on a task, passed on to the agent that owns the task.
//
// Two channels, one for each way a task runs:
//   1. The team engine reads a comment from the task's ticket block when a run
//      STARTS, and a saved wake (`task_wakes`, see ./taskWakes) makes sure a run
//      comes. So it needs no mailbox row: one would show the comment a second time.
//   2. The task runner has no ticket block. It reads the durable mailbox
//      (`agent_inbox`) at the start of a run, so its comment is written there first.
//
// Either way, a comment on a task in progress is also steered into the run working
// on it, through the per-task registry every task-running path registers with (see
// ../runSteers). How it goes in is the runtime's business: live at its next boundary
// (native, Claude Code, Codex, OpenClaw, Hermes over ACP), or by stopping and resuming
// the same session with the comment as the next input (Hermes without ACP). Comments
// in a burst go in as ONE steer: each steer can be a stop and a resume, and an agent
// mid-tool has no use for three. A comment that lands whole goes from what is waiting
// to what that run carries, and it counts as heard only when that run ends well. One
// that does not land, or that did not fit in a steer, stays waiting for the next turn.
//
// A finished or cancelled task forwards nothing: no run will read it.

import {
  enqueueInbox,
  markInboxDelivered,
  markWakeCommentsHeard,
  waitingCommentIds,
  type ClawbooDb,
} from '@clawboo/db'
import type { SteerResult } from '@clawboo/executor'
import { createLogger } from '@clawboo/logger'

import { steerTaskRun } from '../runSteers'

const log = createLogger('task-steer')

const MAX_FORWARDED_CHARS = 1_000

/** How long a comment waits for others to go in with it as one steer. */
export const STEER_BATCH_MS = 1_000

export interface SteerableTask {
  id: string
  title: string
  status: string
  teamId: string | null
  assigneeAgentId: string | null
}

export interface ForwardOutcome {
  /** The comment is on its way to the assignee: in its mailbox, or held by a wake. */
  forwarded: boolean
  /** The steer into the running run, when there was one to try. Resolves after
   *  the comment has been marked (or left) accordingly. Never rejects. */
  steer: Promise<SteerResult> | null
}

export interface ForwardOptions {
  /** The comment's id, when a saved wake holds it. */
  commentId?: string
  /** The task runs on the task runner, which reads comments from the mailbox. */
  mailbox?: boolean
}

interface PendingSteer {
  body: string
  /** The steer carries only part of it, so the agent has not heard it. */
  cut: boolean
  commentId: string | null
  rowId: string | null
}

interface SteerBatch {
  db: ClawbooDb
  title: string
  comments: PendingSteer[]
  timer: ReturnType<typeof setTimeout>
  done: Promise<SteerResult>
  resolve: (r: SteerResult) => void
}

const batches = new Map<string, SteerBatch>()

function steerText(title: string, comments: readonly PendingSteer[]): string {
  const head = `A person commented on your task "${title}"`
  if (comments.length === 1) return `[person steering your task] ${head}: ${comments[0]!.body}`
  const lines = comments.map((c, i) => `${i + 1}. ${c.body}`).join('\n')
  return `[person steering your task] ${head}, ${comments.length} times:\n${lines}`
}

async function flushSteer(taskId: string, batch: SteerBatch): Promise<SteerResult> {
  // A run that started meanwhile took these when its context rendered: they are
  // delivered, and steering them too would show them twice.
  const waiting = waitingCommentIds(batch.db, taskId)
  const comments = batch.comments.filter((c) => !c.commentId || waiting.has(c.commentId))
  if (comments.length === 0) return { delivered: true, mode: 'live' }
  const result = await steerTaskRun(taskId, steerText(batch.title, comments))
  if (result.delivered) {
    try {
      const rowIds = comments.flatMap((c) => (c.rowId ? [c.rowId] : []))
      if (rowIds.length > 0) markInboxDelivered(batch.db, rowIds, 'signal')
      // A comment cut short stays waiting: the next turn's block has all of it.
      markWakeCommentsHeard(
        batch.db,
        taskId,
        comments.flatMap((c) => (c.commentId && !c.cut ? [c.commentId] : [])),
      )
    } catch (err) {
      // It simply rides the next turn as well.
      log.error({ err, taskId }, 'marking a steered comment delivered failed')
    }
  } else if (result.reason !== 'no-run') {
    log.info(
      { taskId, reason: result.reason, detail: result.detail },
      'person comment not steered into the run; it waits for the next turn',
    )
  }
  return result
}

function queueSteer(
  db: ClawbooDb,
  task: SteerableTask,
  comment: PendingSteer,
): Promise<SteerResult> {
  const open = batches.get(task.id)
  if (open) {
    open.comments.push(comment)
    return open.done
  }
  let resolve: (r: SteerResult) => void = () => undefined
  const done = new Promise<SteerResult>((r) => {
    resolve = r
  })
  const timer = setTimeout(() => {
    const batch = batches.get(task.id)
    if (!batch) return
    batches.delete(task.id)
    flushSteer(task.id, batch)
      .catch((err: unknown): SteerResult => ({
        delivered: false,
        reason: 'rejected',
        detail: err instanceof Error ? err.message : String(err),
      }))
      .then(batch.resolve)
      .catch(() => undefined)
  }, STEER_BATCH_MS)
  ;(timer as { unref?: () => void }).unref?.()
  batches.set(task.id, { db, title: task.title, comments: [comment], timer, done, resolve })
  return done
}

/** Test helper: forget every comment waiting to go in. */
export function resetCommentSteers(): void {
  for (const batch of batches.values()) {
    clearTimeout(batch.timer)
    batch.resolve({ delivered: false, reason: 'no-run' })
  }
  batches.clear()
}

/** Pass a comment on, and steer the run going now. See the file header. */
export function forwardPersonCommentToRun(
  db: ClawbooDb,
  task: SteerableTask,
  body: string,
  opts: ForwardOptions = {},
): ForwardOutcome {
  const agentId = task.assigneeAgentId
  if (!agentId || task.status === 'done' || task.status === 'cancelled') {
    return { forwarded: false, steer: null }
  }
  // Cut short, it says so and where the rest is: a steer that ends mid-sentence reads
  // as the whole comment.
  const cut = body.length > MAX_FORWARDED_CHARS
  const text = cut
    ? `${body.slice(0, MAX_FORWARDED_CHARS)}\n… (cut: ${body.length - MAX_FORWARDED_CHARS} more characters. Call get_task for the whole comment.)`
    : body
  let rowId: string | null = null
  if (opts.mailbox) {
    try {
      rowId = enqueueInbox(db, {
        agentId,
        teamId: task.teamId,
        kind: 'alert',
        taskId: task.id,
        body: `A person commented on your task "${task.title}": ${text}`,
      }).id
    } catch (err) {
      log.error({ err, taskId: task.id }, 'forwarding a person comment failed')
      return { forwarded: false, steer: null }
    }
  }
  if (task.status !== 'in_progress') return { forwarded: true, steer: null }
  return {
    forwarded: true,
    steer: queueSteer(db, task, { body: text, cut, commentId: opts.commentId ?? null, rowId }),
  }
}
