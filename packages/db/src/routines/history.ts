// A routine's run history, read back out of the orchestration event log. The
// ticker emits a `routine_fired` for every fire, then a `routine_dispatched` and a
// `routine_completed` or `routine_error`, all carrying the same `scheduledRunId`,
// and the log is append-only and never pruned. Folding those events gives the
// history with no second ledger to keep in step. Fires of one routine never
// overlap (each fire claims the row, and only an idle row is queued again), so
// one fire's events form a contiguous run in `seq` order.

import { and, desc, inArray, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { orchestrationEvents } from '../schema'

const ROUTINE_EVENT_KINDS = [
  'routine_fired',
  'routine_dispatched',
  'routine_completed',
  'routine_error',
] as const

/**
 * - `running`: fired, no outcome yet.
 * - `interrupted`: fired, and the next fire began without an outcome for this one
 *   (the server restarted mid-dispatch). What that run did is unknown.
 */
export type RoutineFireStatus = 'running' | 'succeeded' | 'failed' | 'interrupted'

export interface RoutineFire {
  firedAt: number
  finishedAt: number | null
  status: RoutineFireStatus
  error: string | null
  /** The board task an agent routine's fire created. Null for a team routine. */
  taskId: string | null
  /** Which wake-bridge branch carried it ('team-chat' | 'one-shot' | 'connected'). */
  dispatchPath: string | null
  /** A team routine's recipient: the team lead the message went to. */
  targetAgentId: string | null
}

export const ROUTINE_FIRES_MAX_LIMIT = 50

function parseData(raw: string): Record<string, unknown> {
  try {
    const parsed: unknown = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

/** The most recent fires of one routine, newest first. */
export function listRoutineFires(
  db: ClawbooDb,
  scheduledRunId: string,
  opts: { limit?: number } = {},
): RoutineFire[] {
  const limit = Math.min(Math.max(Math.trunc(opts.limit ?? 10), 1), ROUTINE_FIRES_MAX_LIMIT)
  // A fire writes at most three events. The spare rows let the oldest fire in
  // the window arrive whole; one whose `routine_fired` fell outside the window
  // is skipped below rather than shown without its start.
  const rows = db
    .select({
      ts: orchestrationEvents.ts,
      kind: orchestrationEvents.kind,
      taskId: orchestrationEvents.taskId,
      data: orchestrationEvents.data,
    })
    .from(orchestrationEvents)
    .where(
      and(
        inArray(orchestrationEvents.kind, [...ROUTINE_EVENT_KINDS]),
        sql`json_extract(${orchestrationEvents.data}, '$.scheduledRunId') = ${scheduledRunId}`,
      ),
    )
    .orderBy(desc(orchestrationEvents.seq))
    .limit(limit * 3 + 3)
    .all()

  const fires: RoutineFire[] = []
  let open: RoutineFire | null = null
  for (const row of rows.reverse()) {
    const data = parseData(row.data)
    if (row.kind === 'routine_fired') {
      if (open?.status === 'running') open.status = 'interrupted'
      open = {
        firedAt: row.ts,
        finishedAt: null,
        status: 'running',
        error: null,
        taskId: null,
        dispatchPath: null,
        targetAgentId: null,
      }
      fires.push(open)
      continue
    }
    if (!open) continue
    const taskId = str(data['taskId']) ?? row.taskId ?? null
    if (row.kind === 'routine_dispatched') {
      open.taskId = taskId ?? open.taskId
      open.dispatchPath = str(data['dispatchPath'])
      open.targetAgentId = str(data['targetAgentId'])
    } else if (row.kind === 'routine_completed') {
      open.status = 'succeeded'
      open.finishedAt = row.ts
      open.taskId = taskId ?? open.taskId
    } else if (row.kind === 'routine_error') {
      open.status = 'failed'
      open.finishedAt = row.ts
      open.error = str(data['message']) ?? 'The run failed.'
      open.taskId = taskId ?? open.taskId
    }
  }
  return fires.reverse().slice(0, limit)
}
