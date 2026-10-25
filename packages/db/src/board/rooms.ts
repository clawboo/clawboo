// ─── Chat rooms (data-access layer) ─────────────────────────────────────────
// A team's extra conversations, each a subset of the team's members. The team's
// own group chat is the implicit DEFAULT room and has no row here (room id null
// everywhere a room id appears), so nothing about it had to move.
//
// Membership is stored but never trusted on its own: the live roster of a room is
// its stored members INTERSECTED with the team's active agents (see
// `activeRoomMemberIds`), so an agent that was archived or moved to another team
// drops out of every room without a sweep having to catch it first.

import { randomUUID } from 'node:crypto'

import { and, asc, eq, inArray, isNull } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { agents, roomMembers, rooms, type DbRoom } from '../schema'
import { immediateWrite, withWriteRetry } from './contention'

export interface RoomWithMembers extends DbRoom {
  /** Stored member ids, oldest membership first. */
  memberIds: string[]
}

export const ROOM_NAME_MAX = 80

/** A room name with its whitespace collapsed, or null when nothing is left. */
export function normalizeRoomName(raw: unknown): string | null {
  if (typeof raw !== 'string') return null
  const name = raw.replace(/\s+/g, ' ').trim().slice(0, ROOM_NAME_MAX)
  return name.length > 0 ? name : null
}

/** The team's active (non-archived) agent ids. */
function activeTeamAgentIds(db: ClawbooDb, teamId: string): Set<string> {
  const rows = db
    .select({ id: agents.id, archivedAt: agents.archivedAt })
    .from(agents)
    .where(eq(agents.teamId, teamId))
    .all()
  return new Set(rows.filter((r) => !r.archivedAt).map((r) => r.id))
}

/** The ids in `memberIds` that are NOT active members of `teamId` (empty = all
 *  valid). Duplicates count once. */
export function invalidRoomMembers(db: ClawbooDb, teamId: string, memberIds: string[]): string[] {
  const active = activeTeamAgentIds(db, teamId)
  return [...new Set(memberIds)].filter((id) => !active.has(id))
}

function memberIdsOf(db: ClawbooDb, roomId: string): string[] {
  return db
    .select({ agentId: roomMembers.agentId })
    .from(roomMembers)
    .where(eq(roomMembers.roomId, roomId))
    .orderBy(asc(roomMembers.createdAt), asc(roomMembers.agentId))
    .all()
    .map((r) => r.agentId)
}

export interface CreateRoomInput {
  teamId: string
  name: string
  /** Validated by the caller (`invalidRoomMembers`); duplicates are ignored. */
  memberIds: string[]
  tenantId?: string | null
}

export function createRoom(db: ClawbooDb, input: CreateRoomInput): RoomWithMembers {
  const now = Date.now()
  const room: DbRoom = {
    id: randomUUID(),
    teamId: input.teamId,
    name: input.name,
    tenantId: input.tenantId ?? null,
    archivedAt: null,
    pinnedAt: null,
    createdAt: now,
    updatedAt: now,
  }
  const memberIds = [...new Set(input.memberIds)]
  immediateWrite(db, (tx) => {
    tx.insert(rooms).values(room).run()
    memberIds.forEach((agentId, i) => {
      tx.insert(roomMembers)
        .values({ roomId: room.id, agentId, createdAt: now + i })
        .run()
    })
  })
  return { ...room, memberIds }
}

export function getRoom(db: ClawbooDb, roomId: string): RoomWithMembers | null {
  const room = db.select().from(rooms).where(eq(rooms.id, roomId)).get() as DbRoom | undefined
  return room ? { ...room, memberIds: memberIdsOf(db, roomId) } : null
}

/** The room when it exists, belongs to `teamId` and is not archived; else null. */
export function getActiveRoom(
  db: ClawbooDb,
  teamId: string,
  roomId: string,
): RoomWithMembers | null {
  const room = getRoom(db, roomId)
  if (!room || room.teamId !== teamId || room.archivedAt !== null) return null
  return room
}

export function listRooms(
  db: ClawbooDb,
  teamId: string,
  opts: { includeArchived?: boolean } = {},
): RoomWithMembers[] {
  const conds = [eq(rooms.teamId, teamId)]
  if (!opts.includeArchived) conds.push(isNull(rooms.archivedAt))
  const rows = db
    .select()
    .from(rooms)
    .where(and(...conds))
    .orderBy(asc(rooms.createdAt), asc(rooms.id))
    .all() as DbRoom[]
  if (rows.length === 0) return []
  const members = db
    .select({ roomId: roomMembers.roomId, agentId: roomMembers.agentId })
    .from(roomMembers)
    .where(
      inArray(
        roomMembers.roomId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(asc(roomMembers.createdAt), asc(roomMembers.agentId))
    .all()
  const byRoom = new Map<string, string[]>()
  for (const m of members) {
    const list = byRoom.get(m.roomId) ?? []
    list.push(m.agentId)
    byRoom.set(m.roomId, list)
  }
  return rows.map((r) => ({ ...r, memberIds: byRoom.get(r.id) ?? [] }))
}

export function renameRoom(db: ClawbooDb, roomId: string, name: string): RoomWithMembers | null {
  withWriteRetry(() =>
    db.update(rooms).set({ name, updatedAt: Date.now() }).where(eq(rooms.id, roomId)).run(),
  )
  return getRoom(db, roomId)
}

/** Pin the room to the top of the sidebar's room list, or unpin it. */
export function setRoomPinned(
  db: ClawbooDb,
  roomId: string,
  pinned: boolean,
): RoomWithMembers | null {
  const now = Date.now()
  withWriteRetry(() =>
    db
      .update(rooms)
      .set({ pinnedAt: pinned ? now : null, updatedAt: now })
      .where(eq(rooms.id, roomId))
      .run(),
  )
  return getRoom(db, roomId)
}

/** Replace the room's member set (validated by the caller). Members kept keep
 *  their original join time, so the roster order is stable across edits. */
export function setRoomMembers(
  db: ClawbooDb,
  roomId: string,
  memberIds: string[],
): RoomWithMembers | null {
  const wanted = [...new Set(memberIds)]
  const now = Date.now()
  immediateWrite(db, (tx) => {
    const current = new Set(
      tx
        .select({ agentId: roomMembers.agentId })
        .from(roomMembers)
        .where(eq(roomMembers.roomId, roomId))
        .all()
        .map((r) => r.agentId),
    )
    const drop = [...current].filter((id) => !wanted.includes(id))
    if (drop.length > 0)
      tx.delete(roomMembers)
        .where(and(eq(roomMembers.roomId, roomId), inArray(roomMembers.agentId, drop)))
        .run()
    wanted
      .filter((id) => !current.has(id))
      .forEach((agentId, i) => {
        tx.insert(roomMembers)
          .values({ roomId, agentId, createdAt: now + i })
          .run()
      })
    tx.update(rooms).set({ updatedAt: now }).where(eq(rooms.id, roomId)).run()
  })
  return getRoom(db, roomId)
}

/** Archive a room: it leaves every list, and nothing is deleted. */
export function archiveRoom(db: ClawbooDb, roomId: string): RoomWithMembers | null {
  const now = Date.now()
  withWriteRetry(() =>
    db
      .update(rooms)
      .set({ archivedAt: now, updatedAt: now })
      .where(and(eq(rooms.id, roomId), isNull(rooms.archivedAt)))
      .run(),
  )
  return getRoom(db, roomId)
}

/**
 * The room's LIVE roster: its stored members that are still active agents of the
 * room's team, in membership order. Empty for an unknown or archived room.
 */
export function activeRoomMemberIds(db: ClawbooDb, teamId: string, roomId: string): string[] {
  const room = getActiveRoom(db, teamId, roomId)
  if (!room) return []
  const active = activeTeamAgentIds(db, teamId)
  return room.memberIds.filter((id) => active.has(id))
}

/** Every room id the team has ever had, archived ones included (for sweeps). */
export function listRoomIdsForTeam(db: ClawbooDb, teamId: string): string[] {
  return db
    .select({ id: rooms.id })
    .from(rooms)
    .where(eq(rooms.teamId, teamId))
    .all()
    .map((r) => r.id)
}
