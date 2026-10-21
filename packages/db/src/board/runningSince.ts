// When each task's current run started, read off the execution ledger, so the board
// can show how long an In progress card has been running. Few runs are live at any
// moment and status is indexed, so one read of the running rows serves a whole
// board instead of one query per card.

import { eq } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { executionProcesses } from '../schema'

/**
 * The start of each task's newest running run, keyed by task id. Tasks with no
 * running run are absent.
 */
export function runningSinceForTasks(
  db: ClawbooDb,
  taskIds: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>()
  if (taskIds.length === 0) return out
  const wanted = new Set(taskIds)
  const running = db
    .select({
      taskId: executionProcesses.taskId,
      startedAt: executionProcesses.startedAt,
      claimedAt: executionProcesses.claimedAt,
      createdAt: executionProcesses.createdAt,
    })
    .from(executionProcesses)
    .where(eq(executionProcesses.status, 'running'))
    .all()
  for (const run of running) {
    if (!wanted.has(run.taskId)) continue
    // A row opened before it was claimed or started still has a creation time.
    const since = run.startedAt ?? run.claimedAt ?? run.createdAt
    const seen = out.get(run.taskId)
    if (seen === undefined || since > seen) out.set(run.taskId, since)
  }
  return out
}
