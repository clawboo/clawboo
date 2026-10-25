// Who is in a chat room, who leads it, and which room a task belongs to.
//
// A team's default room (room id null) is its whole active membership, which is
// what every team chat was before rooms. Any other room is its stored members
// that are still active agents of the team. The universal Boo Zero is not a
// stored member of anything: it presides over every room the way it presides
// over every team, so the orchestrator adds it to the roster and routes to it
// first (see `roomLeadId`).

import { activeRoomMemberIds, getActiveRoom, getTask, teams, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { booZeroForTeam } from './booZero'
import { activeTeamAgents } from './teamLead'

export interface RoomAgent {
  id: string
  name: string
}

/** The room's live members, in a stable order (Boo Zero not included). */
export function roomMembers(db: ClawbooDb, teamId: string, roomId: string | null): RoomAgent[] {
  const team = activeTeamAgents(db, teamId).map((a) => ({ id: a.id, name: a.name }))
  if (roomId === null) return team
  const byId = new Map(team.map((a) => [a.id, a]))
  return activeRoomMemberIds(db, teamId, roomId)
    .map((id) => byId.get(id))
    .filter((a): a is RoomAgent => a !== undefined)
}

/** The ids of the room's live members (Boo Zero not included). */
export function roomMemberIdSet(db: ClawbooDb, teamId: string, roomId: string | null): Set<string> {
  return new Set(roomMembers(db, teamId, roomId).map((a) => a.id))
}

/**
 * The room's reduce point: Boo Zero when the install has one (and the team has
 * any members), else the team's own lead while it is a member of this room, else
 * the room's first member. Null for a room with nobody in it. For the default
 * room this is exactly `resolveTeamLeadId`.
 */
export function roomLeadId(db: ClawbooDb, teamId: string, roomId: string | null): string | null {
  const bz = booZeroForTeam(db, teamId)
  if (bz) return bz.id
  const members = roomMembers(db, teamId, roomId)
  const team = db.select().from(teams).where(eq(teams.id, teamId)).get() as
    { leaderAgentId?: string | null } | undefined
  if (team?.leaderAgentId && members.some((a) => a.id === team.leaderAgentId))
    return team.leaderAgentId
  return members[0]?.id ?? null
}

/**
 * The room a task should be driven from: its own room while that room exists,
 * belongs to the task's team and is not archived; otherwise the team's default
 * room. A task whose room was archived can still be retried or reassigned from
 * the board, and the default room's engine is the one left to run it.
 */
export function roomIdForTask(db: ClawbooDb, taskId: string): string | null {
  const task = getTask(db, taskId)
  if (!task?.roomId || !task.teamId) return null
  return getActiveRoom(db, task.teamId, task.roomId) ? task.roomId : null
}

/**
 * Whether a mailbox row belongs in a run in `roomId`. A row about a task goes to
 * that task's room, so a result of work delegated in one room is never read out
 * in another; a row about no task (an alert, a peer signal) goes to whichever of
 * the agent's team runs starts first, as it always has.
 */
export function inboxRowBelongsToRoom(
  db: ClawbooDb,
  row: { taskId?: string | null },
  roomId: string | null,
): boolean {
  if (!row.taskId) return true
  return roomIdForTask(db, row.taskId) === roomId
}
