// Needs-you, read off the database. The classification itself is the pure
// `taskAttention` in @clawboo/board-core; this module only gathers its inputs
// (the task row, its execution ledger, its verification verdict) with one ledger
// read per board rather than one per card.

import { taskAttention, type TaskAttention } from '@clawboo/board-core'
import { isVerdictPromotable } from '@clawboo/governance'

import type { ClawbooDb } from '../db'
import type { DbTask } from '../schema'
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
    // Only these two statuses can ever need a person; skip the ledger read for
    // the rest of the board.
    rows.filter((t) => t.status === 'todo' || t.status === 'blocked').map((t) => t.id),
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
      }),
    )
  }
  return out
}

/** One task's needs-you state, or null when it does not need a person (or does
 *  not exist). */
export function attentionForTask(db: ClawbooDb, taskId: string): TaskAttention | null {
  const row = getTask(db, taskId)
  if (!row) return null
  return attentionForTasks(db, [row]).get(row.id) ?? null
}
