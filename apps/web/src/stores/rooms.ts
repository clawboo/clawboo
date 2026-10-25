// Chat rooms per team: the client's copy of `GET /api/teams/:id/rooms`. Loaded
// when a team's agent list or chat opens, and patched in place after a create,
// edit or archive so the sidebar and the room header update at once.

import { create } from 'zustand'

import { fetchRooms, type Room } from '@/lib/roomsClient'

export type { Room }

const NO_ROOMS: Room[] = []

interface RoomStore {
  roomsByTeam: Map<string, Room[]>
  /** Teams whose rooms have been read at least once. */
  loadedTeams: Set<string>
  load: (teamId: string) => Promise<void>
  /** Insert or replace one room (after a create or an edit). */
  upsert: (room: Room) => void
  /** Drop a room (after it was archived). */
  remove: (teamId: string, roomId: string) => void
}

export const useRoomStore = create<RoomStore>((set) => ({
  roomsByTeam: new Map(),
  loadedTeams: new Set(),

  load: async (teamId) => {
    const rooms = await fetchRooms(teamId)
    // A failed read keeps what we had rather than emptying the sidebar.
    if (rooms === null) return
    set((s) => {
      const byTeam = new Map(s.roomsByTeam)
      byTeam.set(teamId, rooms)
      return { roomsByTeam: byTeam, loadedTeams: new Set(s.loadedTeams).add(teamId) }
    })
  },

  upsert: (room) => {
    set((s) => {
      const byTeam = new Map(s.roomsByTeam)
      const list = [...(byTeam.get(room.teamId) ?? [])]
      const at = list.findIndex((r) => r.id === room.id)
      if (at === -1) list.push(room)
      else list[at] = room
      byTeam.set(room.teamId, list)
      return { roomsByTeam: byTeam }
    })
  },

  remove: (teamId, roomId) => {
    set((s) => {
      const byTeam = new Map(s.roomsByTeam)
      byTeam.set(
        teamId,
        (byTeam.get(teamId) ?? []).filter((r) => r.id !== roomId),
      )
      return { roomsByTeam: byTeam }
    })
  },
}))

/** A team's rooms (a stable empty array until they load). */
export function useTeamRooms(teamId: string | null): Room[] {
  return useRoomStore((s) => (teamId ? (s.roomsByTeam.get(teamId) ?? NO_ROOMS) : NO_ROOMS))
}

/** One room, or null (the team's own group chat, or a room that is gone). */
export function useRoom(teamId: string | null, roomId: string | null): Room | null {
  return useRoomStore((s) =>
    teamId && roomId ? (s.roomsByTeam.get(teamId)?.find((r) => r.id === roomId) ?? null) : null,
  )
}
