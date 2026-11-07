// A question closes unanswered on an event, never on a clock: its task closed or
// moved on, or a newer question replaced it. Separate from ./questions so the
// repository's status write can call it inside its own transaction.

import { and, eq, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { taskComments, taskQuestions } from '../schema'
import type { BoardTx } from './contention'

export type QuestionCloseReason =
  /** A newer question on the task took its place. */
  | 'replaced'
  /** The task reached Done or Cancelled, or was dropped. */
  | 'task_closed'
  /** The task left Blocked some other way: a Retry, a person's move, an Assign. */
  | 'moved'
  /** A person pressed Stop while a plan waited on it. */
  | 'stopped'

/** The task's newest comment by row order, for a question being asked in this transaction
 *  (`comment_mark`). Writes land one at a time and comments are never deleted, so every
 *  comment written after this reads a higher rowid, from any process. */
export function commentMarkTx(tx: BoardTx, taskId: string): number {
  return (
    tx
      .select({ mark: sql<number | null>`max(rowid)` })
      .from(taskComments)
      .where(eq(taskComments.taskId, taskId))
      .get()?.mark ?? 0
  )
}

/** Expire a task's open questions, inside the caller's transaction. Guarded on
 *  `status = 'pending'`, so an answer and an expiry never both land. The key is freed:
 *  nothing is waiting on this question now, so asking it again must really ask. */
export function expirePendingQuestionsTx(
  tx: BoardTx | ClawbooDb,
  taskId: string,
  reason: QuestionCloseReason,
  now: number,
): void {
  tx.update(taskQuestions)
    .set({ status: 'expired', closeReason: reason, idempotencyKey: null, updatedAt: now })
    .where(and(eq(taskQuestions.taskId, taskId), eq(taskQuestions.status, 'pending')))
    .run()
}
