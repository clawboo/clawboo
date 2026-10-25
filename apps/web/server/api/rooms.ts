// Chat rooms inside a team: list, create, rename, change members, archive.
//
// A room is a subset of the team's members with its own conversation and its own
// orchestrator (see lib/teamChat/teamOrchestrator.ts); the universal Boo Zero
// presides over every room the way it presides over the team's own group chat,
// so it is never a stored member. The team's own group chat is the implicit
// default room and is not listed here. Team rules, brief, memory and the board
// stay team-wide.
//
// Deleting a room ARCHIVES it, the way a reset keeps a conversation: its
// transcript stays under its session keys, its in-flight work is stopped (a
// clean release, as the composer's Stop does), and its agents stop resuming the
// conversation. Its tasks stay on the board.

import type { Request, Response } from 'express'
import {
  addRoomMembers,
  archiveRoom,
  createRoom,
  getActiveRoom,
  invalidRoomMembers,
  listRooms,
  normalizeRoomName,
  renameRoom,
  setRoomMembers,
  setRoomPinned,
  settings,
  teams,
  type ClawbooDb,
  type RoomWithMembers,
} from '@clawboo/db'
import { eq, like } from 'drizzle-orm'

import { getDb } from '../lib/db'
import { chatClearedAt } from '../lib/teamChat/chatCleared'
import { nativeTeamSessionKeysForRoomLike } from '../lib/teamChat/nativeTeamSession'
import { retireRoomOrchestrator } from '../lib/teamChat/teamOrchestrator'
import { getTenantId } from '../lib/tenant'

/** What the client sees of a room. */
export interface RoomView {
  id: string
  teamId: string
  name: string
  memberIds: string[]
  /** When it was pinned to the top of the room list; null = not pinned. */
  pinnedAt: number | null
  /** When its chat was last cleared; null = never. */
  chatClearedAt: number | null
  createdAt: number
  updatedAt: number
}

function view(room: RoomWithMembers): RoomView {
  return {
    id: room.id,
    teamId: room.teamId,
    name: room.name,
    memberIds: room.memberIds,
    pinnedAt: room.pinnedAt ?? null,
    chatClearedAt: chatClearedAt(getDb(), room.teamId, room.id),
    createdAt: room.createdAt,
    updatedAt: room.updatedAt,
  }
}

function teamExists(db: ClawbooDb, teamId: string): boolean {
  return db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).get() != null
}

/** Parse + validate a member list against the team. Returns the ids, or an error
 *  message for a 400. */
function readMembers(
  db: ClawbooDb,
  teamId: string,
  raw: unknown,
  field: 'memberIds' | 'addMemberIds' = 'memberIds',
): { ok: true; memberIds: string[] } | { ok: false; error: string } {
  if (!Array.isArray(raw) || raw.some((id) => typeof id !== 'string' || id.length === 0)) {
    return { ok: false, error: `${field} must be an array of agent ids` }
  }
  const memberIds = [...new Set(raw as string[])]
  if (memberIds.length === 0) {
    return {
      ok: false,
      error:
        field === 'memberIds'
          ? 'a room needs at least one member'
          : 'addMemberIds must name at least one agent',
    }
  }
  const invalid = invalidRoomMembers(db, teamId, memberIds)
  if (invalid.length > 0) {
    return { ok: false, error: `not active members of this team: ${invalid.join(', ')}` }
  }
  return { ok: true, memberIds }
}

// ─── GET /api/teams/:id/rooms ────────────────────────────────────────────────

export function teamRoomsGET(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  try {
    res.json({ rooms: listRooms(getDb(), teamId).map(view) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/teams/:id/rooms ───────────────────────────────────────────────
// Body: { name: string, memberIds: string[] }

export function teamRoomsPOST(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  const body = (req.body ?? {}) as { name?: unknown; memberIds?: unknown }
  const name = normalizeRoomName(body.name)
  if (!name) {
    res.status(400).json({ error: 'name required' })
    return
  }
  try {
    const db = getDb()
    if (!teamExists(db, teamId)) {
      res.status(404).json({ error: 'team not found' })
      return
    }
    const members = readMembers(db, teamId, body.memberIds)
    if (!members.ok) {
      res.status(400).json({ error: members.error })
      return
    }
    const room = createRoom(db, {
      teamId,
      name,
      memberIds: members.memberIds,
      tenantId: getTenantId(req),
    })
    res.status(201).json({ room: view(room) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PATCH /api/teams/:id/rooms/:roomId ──────────────────────────────────────
// Body: partial { name?, memberIds?, addMemberIds?, pinned? }. `memberIds`
// replaces the roster; `addMemberIds` adds to it, so two adds sent at the same
// time both land.

export function teamRoomPATCH(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  const roomId = req.params['roomId'] as string | undefined
  if (!teamId || !roomId) {
    res.status(400).json({ error: 'team id and room id required' })
    return
  }
  const body = (req.body ?? {}) as {
    name?: unknown
    memberIds?: unknown
    addMemberIds?: unknown
    pinned?: unknown
  }
  if (body.pinned !== undefined && typeof body.pinned !== 'boolean') {
    res.status(400).json({ error: 'pinned must be true or false' })
    return
  }
  if (body.memberIds !== undefined && body.addMemberIds !== undefined) {
    res.status(400).json({ error: 'send memberIds or addMemberIds, not both' })
    return
  }
  if (
    body.name === undefined &&
    body.memberIds === undefined &&
    body.addMemberIds === undefined &&
    body.pinned === undefined
  ) {
    res.status(400).json({ error: 'nothing to change' })
    return
  }
  try {
    const db = getDb()
    if (!getActiveRoom(db, teamId, roomId)) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    let name: string | null = null
    if (body.name !== undefined) {
      name = normalizeRoomName(body.name)
      if (!name) {
        res.status(400).json({ error: 'name must not be empty' })
        return
      }
    }
    let memberIds: string[] | null = null
    if (body.memberIds !== undefined) {
      const members = readMembers(db, teamId, body.memberIds)
      if (!members.ok) {
        res.status(400).json({ error: members.error })
        return
      }
      memberIds = members.memberIds
    }
    let addMemberIds: string[] | null = null
    if (body.addMemberIds !== undefined) {
      const members = readMembers(db, teamId, body.addMemberIds, 'addMemberIds')
      if (!members.ok) {
        res.status(400).json({ error: members.error })
        return
      }
      addMemberIds = members.memberIds
    }
    if (name !== null) renameRoom(db, roomId, name)
    if (typeof body.pinned === 'boolean') setRoomPinned(db, roomId, body.pinned)
    // A removed member's in-flight turn finishes; the room's next turns no
    // longer list or route to it (the roster is read fresh every turn).
    if (memberIds !== null) setRoomMembers(db, roomId, memberIds)
    if (addMemberIds !== null) addRoomMembers(db, roomId, addMemberIds)
    const room = getActiveRoom(db, teamId, roomId)
    if (!room) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    res.json({ room: view(room) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── DELETE /api/teams/:id/rooms/:roomId ─────────────────────────────────────
// Archives the room: see the file header.

export function teamRoomDELETE(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  const roomId = req.params['roomId'] as string | undefined
  if (!teamId || !roomId) {
    res.status(400).json({ error: 'team id and room id required' })
    return
  }
  try {
    const db = getDb()
    if (!getActiveRoom(db, teamId, roomId)) {
      res.status(404).json({ error: 'room not found' })
      return
    }
    // Stop first, so nothing the room's engine is running outlives the room.
    retireRoomOrchestrator(teamId, roomId)
    // Its agents start fresh if the room were ever reopened: no resume pointer
    // carries the archived conversation forward.
    db.delete(settings)
      .where(like(settings.key, nativeTeamSessionKeysForRoomLike(teamId, roomId)))
      .run()
    archiveRoom(db, roomId)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
