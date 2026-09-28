// Who leads a team's chat: the reduce point an unaddressed message is routed to.
// Boo Zero when the install has one (one universal Boo Zero leads every team),
// else the team's own lead while that agent is an active member, else the first
// active member. Null for a team with no active members.

import { agents, teams, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { booZeroForTeam } from './booZero'

export function activeTeamAgents(
  db: ClawbooDb,
  teamId: string,
): Array<{ id: string; name: string; archivedAt?: number | null }> {
  const rows = db.select().from(agents).where(eq(agents.teamId, teamId)).all() as Array<{
    id: string
    name: string
    archivedAt?: number | null
  }>
  return rows.filter((a) => !a.archivedAt)
}

export function resolveTeamLeadId(db: ClawbooDb, teamId: string): string | null {
  const bz = booZeroForTeam(db, teamId)
  if (bz) return bz.id
  const team = db.select().from(teams).where(eq(teams.id, teamId)).get() as
    { leaderAgentId?: string | null } | undefined
  const members = activeTeamAgents(db, teamId)
  if (team?.leaderAgentId && members.some((a) => a.id === team.leaderAgentId))
    return team.leaderAgentId
  return members[0]?.id ?? null
}
