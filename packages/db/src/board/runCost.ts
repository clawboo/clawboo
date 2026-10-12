// What each task's runs cost, read off the database. The sum itself is the pure
// `summarizeRunCost` in @clawboo/board-core; this module only gathers its inputs
// (each run's recorded cost and where it came from) with one ledger read per board
// rather than one per card.

import { summarizeRunCost, type TaskRunCost } from '@clawboo/board-core'
import { and, inArray, isNotNull } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { executionProcesses, type DbTask } from '../schema'
import { getTask } from './repository'

/** What each task's runs cost, keyed by task id. */
export function runCostForTasks(
  db: ClawbooDb,
  rows: ReadonlyArray<Pick<DbTask, 'id' | 'costUsd'>>,
): Map<string, TaskRunCost> {
  const ledgers = new Map<string, Array<{ costUsd: number | null; costSource: string | null }>>()
  for (const t of rows) ledgers.set(t.id, [])
  const ids = [...ledgers.keys()]
  // Chunked so a large board never exceeds SQLite's bound parameter limit. Only the
  // three columns the sum needs: a full row carries a run's summary, and this runs
  // on every board poll.
  const CHUNK = 500
  for (let i = 0; i < ids.length; i += CHUNK) {
    const costed = db
      .select({
        taskId: executionProcesses.taskId,
        costUsd: executionProcesses.costUsd,
        costSource: executionProcesses.costSource,
      })
      .from(executionProcesses)
      .where(
        and(
          inArray(executionProcesses.taskId, ids.slice(i, i + CHUNK)),
          isNotNull(executionProcesses.costUsd),
        ),
      )
      .all()
    for (const run of costed) ledgers.get(run.taskId)?.push(run)
  }
  const out = new Map<string, TaskRunCost>()
  for (const t of rows) out.set(t.id, summarizeRunCost(ledgers.get(t.id) ?? [], t.costUsd))
  return out
}

/** What one task's runs cost, or null when the task does not exist. */
export function runCostForTask(db: ClawbooDb, taskId: string): TaskRunCost | null {
  const row = getTask(db, taskId)
  if (!row) return null
  return runCostForTasks(db, [row]).get(row.id) ?? null
}
