// What an agent says about its task (`report_result`), kept on the run that said it. A
// report, not a move: nothing here touches a status, and the server decides Done when
// the run ends (`decideDone` in @clawboo/board-core). On the run's row, so a claim ends
// with its run: a fix round or a follow-up starts with none.

import { parseResultClaim, type ResultClaim } from '@clawboo/board-core'
import { and, eq } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { executionProcesses, tasks } from '../schema'
import { withWriteRetry } from './contention'

export type RecordResultClaimResult =
  { ok: true } | { ok: false; reason: 'not_found' | 'not_yours' | 'no_run' }

/** Store what this agent says about the run it is doing on this task. The last one it
 *  makes stands. Refused for a task it is not working on, or with no run open. The run is
 *  the one its signed binding names (`executionId`), so a session left over from an earlier
 *  run cannot speak for a later one. A session whose URL names no run reports on the run
 *  the task is stamped with. */
export function recordResultClaim(
  db: ClawbooDb,
  taskId: string,
  agentId: string,
  claim: ResultClaim,
  opts: { executionId?: string | null } = {},
): RecordResultClaimResult {
  const task = db
    .select({ assignee: tasks.assigneeAgentId, execId: tasks.runExecutionId })
    .from(tasks)
    .where(eq(tasks.id, taskId))
    .get()
  if (!task) return { ok: false, reason: 'not_found' }
  if (task.assignee !== agentId) return { ok: false, reason: 'not_yours' }
  const execId = opts.executionId ?? task.execId
  if (!execId) return { ok: false, reason: 'no_run' }
  const written = withWriteRetry(() =>
    db
      .update(executionProcesses)
      .set({ resultClaim: JSON.stringify(claim) })
      .where(
        and(
          eq(executionProcesses.id, execId),
          eq(executionProcesses.taskId, taskId),
          eq(executionProcesses.status, 'running'),
        ),
      )
      .run(),
  )
  return written.changes > 0 ? { ok: true } : { ok: false, reason: 'no_run' }
}

/** The claim a run's agent made, or null when it made none. */
export function readResultClaim(db: ClawbooDb, execId: string): ResultClaim | null {
  const row = db
    .select({ claim: executionProcesses.resultClaim })
    .from(executionProcesses)
    .where(eq(executionProcesses.id, execId))
    .get()
  return parseResultClaim(row?.claim)
}
