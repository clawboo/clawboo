// report_up_outbox accessors: the team chat's durable `[Task Update]` outbox.
// See the schema comment for the model. The payload is the engine's item as
// opaque JSON; this layer only stores, lists and settles it, so the database
// package never depends on the orchestration engine.

import { randomUUID } from 'node:crypto'

import { and, asc, eq, inArray, isNotNull, isNull, sql } from 'drizzle-orm'

import type { ClawbooDb } from './db'
import { withWriteRetry } from './board/contention'
import { reportUpOutbox, type DbReportUpOutboxRow } from './schema'

/** How a report-up was closed. Mirrors the engine's `ReportUpSettlement`. */
export type ReportUpSettledHow = 'delivered' | 'stopped' | 'gave_up'

export interface RecordReportUpInput {
  teamId: string
  /** The chat room; null is the team's own group chat. */
  roomId: string | null
  /** Null resolves to the room's lead when it is sent. */
  recipientAgentId: string | null
  taskId: string | null
  payload: string
  /** It came back after a person's Stop: it starts no run, and rides the
   *  recipient's next one. */
  held?: boolean
}

/** Store one report-up as the engine queues it. Returns its id. */
export function recordReportUp(db: ClawbooDb, input: RecordReportUpInput): string {
  const id = randomUUID()
  withWriteRetry(() =>
    db
      .insert(reportUpOutbox)
      .values({
        id,
        teamId: input.teamId,
        roomId: input.roomId,
        recipientAgentId: input.recipientAgentId,
        taskId: input.taskId,
        payload: input.payload,
        replays: 0,
        createdAt: Date.now(),
        settledAt: null,
        settledHow: null,
        heldAt: input.held ? Date.now() : null,
      })
      .run(),
  )
  return id
}

/** Unsettled report-ups for one chat room that a Stop did not hold, oldest first:
 *  the ones to send. */
export function listPendingReportUps(
  db: ClawbooDb,
  teamId: string,
  roomId: string | null,
): DbReportUpOutboxRow[] {
  return (
    db
      .select()
      .from(reportUpOutbox)
      .where(
        and(
          eq(reportUpOutbox.teamId, teamId),
          roomId === null ? isNull(reportUpOutbox.roomId) : eq(reportUpOutbox.roomId, roomId),
          isNull(reportUpOutbox.settledAt),
          isNull(reportUpOutbox.heldAt),
        ),
      )
      // rowid breaks a same-millisecond tie in insertion order, as the inbox does.
      .orderBy(asc(reportUpOutbox.createdAt), sql`rowid`)
      .all() as DbReportUpOutboxRow[]
  )
}

/** Unsettled report-ups for one chat room that a Stop held, oldest first: the ones
 *  that wait for the recipient's next run. */
export function listHeldReportUps(
  db: ClawbooDb,
  teamId: string,
  roomId: string | null,
): DbReportUpOutboxRow[] {
  return db
    .select()
    .from(reportUpOutbox)
    .where(
      and(
        eq(reportUpOutbox.teamId, teamId),
        roomId === null ? isNull(reportUpOutbox.roomId) : eq(reportUpOutbox.roomId, roomId),
        isNull(reportUpOutbox.settledAt),
        isNotNull(reportUpOutbox.heldAt),
      ),
    )
    .orderBy(asc(reportUpOutbox.createdAt), sql`rowid`)
    .all() as DbReportUpOutboxRow[]
}

/** A person's Stop: these rows start no run from now on, and ride the recipient's
 *  next one. */
export function holdReportUps(db: ClawbooDb, ids: string[]): void {
  if (ids.length === 0) return
  const now = Date.now()
  withWriteRetry(() =>
    db
      .update(reportUpOutbox)
      .set({ heldAt: now })
      .where(and(inArray(reportUpOutbox.id, ids), isNull(reportUpOutbox.settledAt)))
      .run(),
  )
}

/** Count one more replay of each still-pending row. */
export function markReportUpsReplayed(db: ClawbooDb, ids: string[]): void {
  if (ids.length === 0) return
  withWriteRetry(() =>
    db
      .update(reportUpOutbox)
      .set({ replays: sql`${reportUpOutbox.replays} + 1` })
      .where(and(inArray(reportUpOutbox.id, ids), isNull(reportUpOutbox.settledAt)))
      .run(),
  )
}

/**
 * Settle rows that are still pending. Guarded on `settled_at IS NULL`, so the
 * first settlement wins (a Stop that dropped an update is not rewritten as
 * delivered when the aborted run's terminal lands). Returns the ids this call
 * settled.
 */
export function settleReportUps(db: ClawbooDb, ids: string[], how: ReportUpSettledHow): string[] {
  if (ids.length === 0) return []
  const won = withWriteRetry(() =>
    db
      .update(reportUpOutbox)
      .set({ settledAt: Date.now(), settledHow: how })
      .where(and(inArray(reportUpOutbox.id, ids), isNull(reportUpOutbox.settledAt)))
      .returning({ id: reportUpOutbox.id })
      .all(),
  ) as Array<{ id: string }>
  return won.map((r) => r.id)
}

/** Chat rooms holding unsettled report-ups to send: the boot-resume scan. One a Stop
 *  held wakes no one, so it does not bring a room back. */
export function listRoomsWithPendingReportUps(
  db: ClawbooDb,
): Array<{ teamId: string; roomId: string | null }> {
  return db
    .selectDistinct({ teamId: reportUpOutbox.teamId, roomId: reportUpOutbox.roomId })
    .from(reportUpOutbox)
    .where(and(isNull(reportUpOutbox.settledAt), isNull(reportUpOutbox.heldAt)))
    .all() as Array<{ teamId: string; roomId: string | null }>
}

/** A settled row is kept this long, for debugging, then deleted. */
export const REPORT_UP_SETTLED_RETENTION_MS = 7 * 24 * 60 * 60_000
/** A pending row older than this is deleted unsent, one a Stop held for a recipient
 *  that never ran again included: its result is on the board. */
export const REPORT_UP_PENDING_MAX_AGE_MS = 30 * 24 * 60 * 60_000

/**
 * Retention: settled rows past their retention, pending rows past the maximum
 * age, and pending rows whose team no longer exists are deleted, so the boot
 * scan never wakes a ghost. Returns how many rows were deleted.
 */
export function reapReportUps(db: ClawbooDb, at = Date.now()): number {
  const settledCutoff = at - REPORT_UP_SETTLED_RETENTION_MS
  const pendingCutoff = at - REPORT_UP_PENDING_MAX_AGE_MS
  const result = withWriteRetry(() =>
    db.run(
      sql`DELETE FROM report_up_outbox WHERE (settled_at IS NOT NULL AND settled_at < ${settledCutoff}) OR (settled_at IS NULL AND (created_at < ${pendingCutoff} OR team_id NOT IN (SELECT id FROM teams)))`,
    ),
  )
  return Number((result as { changes?: number }).changes ?? 0)
}
