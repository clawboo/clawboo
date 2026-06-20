// Verification storage — board state that gates a board transition, so it lives
// beside the state machine + repository (shares `withWriteRetry`). The typed
// VerificationResult is validated on WRITE; the `updateStatus` gate only reads
// `.status === 'pass'` (a lightweight inline parse there avoids importing this
// module, which would create a cycle with repository's `getTask`).

import { verificationResultSchema, type VerificationResult } from '@clawboo/governance'
import { eq } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { tasks } from '../schema'
import { withWriteRetry } from './contention'
import { getTask } from './repository'

/** Persist the typed verification verdict on a task (zod-validated on write). */
export function setTaskVerification(
  db: ClawbooDb,
  taskId: string,
  result: VerificationResult,
): void {
  const json = JSON.stringify(verificationResultSchema.parse(result))
  withWriteRetry(() =>
    db
      .update(tasks)
      .set({ verification: json, updatedAt: Date.now() })
      .where(eq(tasks.id, taskId))
      .run(),
  )
}

/** Read the typed verification verdict (zod-validated; null when absent/invalid). */
export function getTaskVerification(db: ClawbooDb, taskId: string): VerificationResult | null {
  const row = getTask(db, taskId)
  if (!row?.verification) return null
  try {
    const parsed = verificationResultSchema.safeParse(JSON.parse(row.verification))
    return parsed.success ? parsed.data : null
  } catch {
    return null
  }
}
