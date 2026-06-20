// ─── team_chat room substrate (data-access) ──────────────────────────────────
// The ONLY place that reads/writes the `team_chat` table — the durable
// group-chat room where every team member posts as a NAMED PEER. Mirrors the
// board / sessions repository convention (raw Drizzle stays behind this module;
// the single seam a future SQLite→Postgres / multi-tenant swap targets).
//
// Invariants:
//  - `seq` is per-room monotonic, assigned `MAX(seq)+1 WHERE room_id=?` inside a
//    BEGIN IMMEDIATE write tx (the board contention recipe) so concurrent posters
//    never collide on the `(room_id, seq)` unique index.
//  - `readRoom` is a cursor read (`sinceSeq`) and supports `excludeAuthorId` —
//    that exclusion IS the per-(roomId, authorAgentId) echo guard: a poster never
//    receives its OWN posts back as new input.
//  - The board stays canonical: a post NEVER mutates the board (this module has no
//    board access). Decisions land via the board repository, which the reflect
//    path narrates here as a `kind:'system'` line.
//  - Tenant-scopable: `teamId` is on every row and the read query is written so a
//    `tenantId` scope can be AND-ed in later (the dormant multi-tenant seam — no
//    column today).

import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, gt, ne, type SQL } from 'drizzle-orm'

import { immediateWrite } from '../board/contention'
import type { ClawbooDb } from '../db'
import { teamChat, type DbTeamChat } from '../schema'

/** A post's kind: a teammate's post, board-mutation narration, or user input. */
export type TeamChatKind = 'peer' | 'system' | 'user'

export interface PostToRoomInput {
  roomId: string
  teamId: string
  authorAgentId: string
  body: string
  kind?: TeamChatKind
}

export interface ReadRoomInput {
  roomId: string
  /** Cursor — return only posts with `seq > sinceSeq` (default 0 = whole room). */
  sinceSeq?: number
  /** Per-poster echo guard — omit posts authored by this agent. */
  excludeAuthorId?: string | null
  /** Cap the batch (newest-bounded by seq asc). */
  limit?: number
}

/** The default room for a team. Kept distinct from `teamId` so a team could later
 *  carry >1 room without a schema change (the multi-room seam). */
export function resolveRoomForTeam(teamId: string): string {
  return `team:${teamId}`
}

/**
 * Append a post to a room. Assigns the next per-room `seq` (`MAX(seq)+1`) inside a
 * BEGIN IMMEDIATE transaction so two concurrent posters can't both claim the same
 * seq. Returns the written row. Empty bodies are rejected by the caller (the MCP
 * tool / REST layer) — this is the durable writer, not a validator.
 */
export function postToRoom(db: ClawbooDb, input: PostToRoomInput): DbTeamChat {
  const now = Date.now()
  return immediateWrite(db, (tx) => {
    // Next seq = MAX(seq) for the room, read via the (room_id, seq) index in O(1)
    // — `ORDER BY seq DESC LIMIT 1` instead of scanning + JS-reducing every row.
    const top = tx
      .select({ seq: teamChat.seq })
      .from(teamChat)
      .where(eq(teamChat.roomId, input.roomId))
      .orderBy(desc(teamChat.seq))
      .limit(1)
      .get() as { seq: number } | undefined
    const maxSeq = top?.seq ?? 0
    const row: DbTeamChat = {
      id: randomUUID(),
      roomId: input.roomId,
      teamId: input.teamId,
      authorAgentId: input.authorAgentId,
      body: input.body,
      kind: input.kind ?? 'peer',
      createdAt: now,
      seq: maxSeq + 1,
    }
    tx.insert(teamChat).values(row).run()
    return row
  })
}

/**
 * Cursor read of a room in `seq` order. With `excludeAuthorId` set, the poster's
 * OWN posts are filtered out — the per-(roomId, authorAgentId) echo guard that
 * keeps a subscriber from re-ingesting what it just said.
 */
export function readRoom(db: ClawbooDb, input: ReadRoomInput): DbTeamChat[] {
  const conds: SQL[] = [eq(teamChat.roomId, input.roomId)]
  if (input.sinceSeq && input.sinceSeq > 0) conds.push(gt(teamChat.seq, input.sinceSeq))
  if (input.excludeAuthorId) conds.push(ne(teamChat.authorAgentId, input.excludeAuthorId))
  return db
    .select()
    .from(teamChat)
    .where(and(...conds))
    .orderBy(asc(teamChat.seq))
    .limit(input.limit && input.limit > 0 ? input.limit : 1000)
    .all()
}

/**
 * The current head `seq` of a room (0 when empty). A cheap indexed read
 * (`ORDER BY seq DESC LIMIT 1`, no author filter). A subscriber advances its
 * cursor to this even when its OWN posts are the latest — `readRoom` excludes
 * the caller's own posts, so the last DELIVERED row can sit below the true head
 * and stall the cursor; the unfiltered MAX(seq) lets it reach the room head.
 */
export function roomMaxSeq(db: ClawbooDb, roomId: string): number {
  const top = db
    .select({ seq: teamChat.seq })
    .from(teamChat)
    .where(eq(teamChat.roomId, roomId))
    .orderBy(desc(teamChat.seq))
    .limit(1)
    .get() as { seq: number } | undefined
  return top?.seq ?? 0
}
