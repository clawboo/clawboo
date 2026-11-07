// A question closes unanswered on an event, never on a clock: its task closed or
// moved on, or a newer question replaced it. Separate from ./questions so the
// repository's status write can call it inside its own transaction.

import { and, eq } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { taskQuestions } from '../schema'
import type { BoardTx } from './contention'

export type QuestionCloseReason =
  /** A newer question on the task took its place. */
  | 'replaced'
  /** The task reached Done or Cancelled, or was dropped. */
  | 'task_closed'
  /** The task left Blocked some other way: a Retry, a person's move, an Assign. */
  | 'moved'

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
