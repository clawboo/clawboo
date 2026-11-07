// Needs-you, read off the database. The classification itself is the pure
// `taskAttention` in @clawboo/board-core; this module only gathers its inputs
// (the task row, its execution ledger, its verification verdict) with one ledger
// read per board rather than one per card.

import { taskAttention, type TaskAttention } from '@clawboo/board-core'
import { isVerdictPromotable } from '@clawboo/governance'
import { and, eq, inArray } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { tasks, type DbTask } from '../schema'
import { getTask, listExecutionsForTasks } from './repository'

/** A stored verdict exists and cannot be promoted to done. An absent or
 *  unreadable cell is "unverified", which is not the same as failing. */
function verificationBlocks(cell: string | null | undefined): boolean {
  if (!cell) return false
  try {
    return !isVerdictPromotable(JSON.parse(cell))
  } catch {
    return false
  }
}

/** Why each task needs a person (null when it does not), keyed by task id. */
export function attentionForTasks(
  db: ClawbooDb,
  rows: readonly DbTask[],
): Map<string, TaskAttention | null> {
  const ledgers = listExecutionsForTasks(
    db,
    // Only these can ever need a person; skip the ledger read for the rest of
    // the board.
    rows
      .filter(
        (t) =>
          t.status === 'todo' ||
          t.status === 'blocked' ||
          (t.status === 'in_progress' && !t.assigneeAgentId),
      )
      .map((t) => t.id),
  )
  const out = new Map<string, TaskAttention | null>()
  for (const t of rows) {
    out.set(
      t.id,
      taskAttention({
        status: t.status,
        sourceDelegationId: t.sourceDelegationId,
        execs: ledgers.get(t.id) ?? [],
        verificationBlocked: verificationBlocks(t.verification),
        assigneeAgentId: t.assigneeAgentId,
        personMovedAt: t.personMovedAt,
      }),
    )
  }
  return out
}

/** The tasks that need a person, without reading the whole board: most of it is
 *  finished work, which never can. The same statuses as the ledger read above. */
export function taskIdsNeedingPerson(db: ClawbooDb): string[] {
  const rows = db
    .select()
    .from(tasks)
    .where(and(inArray(tasks.status, ['todo', 'blocked', 'in_progress']), eq(tasks.dropped, 0)))
    .all() as DbTask[]
  const attention = attentionForTasks(db, rows)
  return rows.filter((t) => attention.get(t.id)).map((t) => t.id)
}

/** One task's needs-you state, or null when it does not need a person (or does
 *  not exist). */
export function attentionForTask(db: ClawbooDb, taskId: string): TaskAttention | null {
  const row = getTask(db, taskId)
  if (!row) return null
  return attentionForTasks(db, [row]).get(row.id) ?? null
}
