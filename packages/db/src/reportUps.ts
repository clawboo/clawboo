// report_up_outbox accessors: the durable `[Task Update]` outbox, for team chats and
// for one-to-one chats, which each keep to their own rows. See the schema comment
// for the model. The payload is the engine's item as
// opaque JSON; this layer only stores, lists and settles it, so the database
// package never depends on the orchestration engine.

import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, inArray, isNotNull, isNull, or, sql } from 'drizzle-orm'

import type { ClawbooDb } from './db'
import { withWriteRetry } from './board/contention'
import { reportUpOutbox, type DbReportUpOutboxRow } from './schema'

/** `team_id` of a one-to-one chat's row about a hand-off that reached no team, which
 *  the column requires and no team has. It waits for the chat's next turn. */
export const NO_TEAM_REPORT_UP = ''

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
  /** It goes to this one-to-one chat instead of a team or room session. */
  chatSessionKey?: string | null
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
        chatSessionKey: input.chatSessionKey ?? null,
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
          isNull(reportUpOutbox.chatSessionKey),
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
        isNull(reportUpOutbox.chatSessionKey),
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
    .where(
      and(
        isNull(reportUpOutbox.chatSessionKey),
        isNull(reportUpOutbox.settledAt),
        isNull(reportUpOutbox.heldAt),
      ),
    )
    .all() as Array<{ teamId: string; roomId: string | null }>
}

/** The newest report-up to this agent about any of these tasks, settled or not: what
 *  the agent looking after a request last heard about it, in a team session or in the
 *  one-to-one chat the request came from. A row with no recipient is the room's lead's.
 *  Null when there is none. */
export function latestReportUpForTasks(
  db: ClawbooDb,
  taskIds: readonly string[],
  recipientAgentId: string | null,
): DbReportUpOutboxRow | null {
  if (taskIds.length === 0) return null
  return (
    (db
      .select()
      .from(reportUpOutbox)
      .where(
        and(
          inArray(reportUpOutbox.taskId, [...taskIds]),
          ...(recipientAgentId
            ? [
                or(
                  isNull(reportUpOutbox.recipientAgentId),
                  eq(reportUpOutbox.recipientAgentId, recipientAgentId),
                ),
              ]
            : []),
        ),
      )
      .orderBy(desc(reportUpOutbox.createdAt), sql`rowid DESC`)
      .limit(1)
      .get() as DbReportUpOutboxRow | undefined) ?? null
  )
}

/** Unsettled report-ups for one one-to-one chat that a Stop did not hold, oldest
 *  first: the ones to send. */
export function listPendingChatReportUps(db: ClawbooDb, sessionKey: string): DbReportUpOutboxRow[] {
  return db
    .select()
    .from(reportUpOutbox)
    .where(
      and(
        eq(reportUpOutbox.chatSessionKey, sessionKey),
        isNull(reportUpOutbox.settledAt),
        isNull(reportUpOutbox.heldAt),
      ),
    )
    .orderBy(asc(reportUpOutbox.createdAt), sql`rowid`)
    .all() as DbReportUpOutboxRow[]
}

/** Unsettled report-ups for one one-to-one chat that wait for its next run, oldest
 *  first. */
export function listHeldChatReportUps(db: ClawbooDb, sessionKey: string): DbReportUpOutboxRow[] {
  return db
    .select()
    .from(reportUpOutbox)
    .where(
      and(
        eq(reportUpOutbox.chatSessionKey, sessionKey),
        isNull(reportUpOutbox.settledAt),
        isNotNull(reportUpOutbox.heldAt),
      ),
    )
    .orderBy(asc(reportUpOutbox.createdAt), sql`rowid`)
    .all() as DbReportUpOutboxRow[]
}

/** Unsettled rows this team has kept for one-to-one chats, held ones too. No team reader
 *  sends these, but a request filed under one of them is not all in until they settle. */
export function listUnsettledChatReportUpsOfTeam(
  db: ClawbooDb,
  teamId: string,
): DbReportUpOutboxRow[] {
  return db
    .select()
    .from(reportUpOutbox)
    .where(
      and(
        eq(reportUpOutbox.teamId, teamId),
        isNotNull(reportUpOutbox.chatSessionKey),
        isNull(reportUpOutbox.settledAt),
      ),
    )
    .orderBy(asc(reportUpOutbox.createdAt), sql`rowid`)
    .all() as DbReportUpOutboxRow[]
}

/** One-to-one chats holding report-ups to send: the boot-resume scan. */
export function listChatsWithPendingReportUps(db: ClawbooDb): string[] {
  const rows = db
    .selectDistinct({ chatSessionKey: reportUpOutbox.chatSessionKey })
    .from(reportUpOutbox)
    .where(
      and(
        isNotNull(reportUpOutbox.chatSessionKey),
        isNull(reportUpOutbox.settledAt),
        isNull(reportUpOutbox.heldAt),
      ),
    )
    .all() as Array<{ chatSessionKey: string }>
  return rows.map((r) => r.chatSessionKey)
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
      sql`DELETE FROM report_up_outbox WHERE (settled_at IS NOT NULL AND settled_at < ${settledCutoff}) OR (settled_at IS NULL AND (created_at < ${pendingCutoff} OR (team_id <> ${NO_TEAM_REPORT_UP} AND team_id NOT IN (SELECT id FROM teams))))`,
    ),
  )
  return Number((result as { changes?: number }).changes ?? 0)
}
