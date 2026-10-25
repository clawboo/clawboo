// Chat rooms inside a team: the REST client. A room is a subset of the team's
// members with its own conversation; the team's own group chat is the default
// room and is not one of these. See apps/web/server/api/rooms.ts.

import { apiFetch } from '@clawboo/control-client'

export interface Room {
  id: string
  teamId: string
  name: string
  memberIds: string[]
  /** When it was pinned to the top of the room list; null = not pinned. */
  pinnedAt: number | null
  /** When its chat was last cleared (epoch ms); its chat stops showing the board
   *  tasks made before then. Absent or null = never. */
  chatClearedAt?: number | null
  createdAt: number
  updatedAt: number
}

/** The team's own group chat, shown as the first, pinned room with everyone in it. */
export const DEFAULT_ROOM_NAME = 'General'

/** Either the room, or the server's reason it refused (shown to the person). */
export type RoomResult = { ok: true; room: Room } | { ok: false; error: string }

const roomsPath = (teamId: string): string => `/api/teams/${encodeURIComponent(teamId)}/rooms`

async function errorOf(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown }
    if (typeof body.error === 'string' && body.error) return body.error
  } catch {
    // fall through
  }
  return `request failed (${res.status})`
}

/** The team's active rooms, oldest first. Null when they could not be read. */
export async function fetchRooms(teamId: string): Promise<Room[] | null> {
  try {
    const res = await apiFetch(roomsPath(teamId))
    if (!res.ok) return null
    const body = (await res.json()) as { rooms?: Room[] }
    return Array.isArray(body.rooms) ? body.rooms : []
  } catch {
    return null
  }
}

export async function createRoom(
  teamId: string,
  input: { name: string; memberIds: string[] },
): Promise<RoomResult> {
  try {
    const res = await apiFetch(roomsPath(teamId), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(input),
    })
    if (!res.ok) return { ok: false, error: await errorOf(res) }
    const body = (await res.json()) as { room: Room }
    return { ok: true, room: body.room }
  } catch {
    return { ok: false, error: 'Could not reach the server.' }
  }
}

export async function updateRoom(
  teamId: string,
  roomId: string,
  patch: { name?: string; memberIds?: string[]; pinned?: boolean },
): Promise<RoomResult> {
  try {
    const res = await apiFetch(`${roomsPath(teamId)}/${encodeURIComponent(roomId)}`, {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
    if (!res.ok) return { ok: false, error: await errorOf(res) }
    const body = (await res.json()) as { room: Room }
    return { ok: true, room: body.room }
  } catch {
    return { ok: false, error: 'Could not reach the server.' }
  }
}

/** Archive a room (its conversation is kept, its in-flight work is stopped). */
export async function archiveRoom(teamId: string, roomId: string): Promise<boolean> {
  try {
    const res = await apiFetch(`${roomsPath(teamId)}/${encodeURIComponent(roomId)}`, {
      method: 'DELETE',
    })
    return res.ok
  } catch {
    return false
  }
}
