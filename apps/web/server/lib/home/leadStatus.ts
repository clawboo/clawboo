// Whether a team's lead can write the Home status line. The line is written with
// the Tasks tool `write_home_summary`, which is offered only to a session bound to
// its agent. An OpenClaw agent's Tasks tools carry no identity (an unverified
// caller), so an OpenClaw lead is never offered it, and asking it would spend a
// model call for nothing. A team with no lead cannot write it either.

import { agents, getTeamHomeSettings, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { resolveTeamLeadId } from '../teamChat/teamLead'

export function leadCanWriteStatus(db: ClawbooDb, teamId: string): boolean {
  const lead = resolveTeamLeadId(db, teamId)
  if (!lead) return false
  const row = db.select({ runtime: agents.runtime }).from(agents).where(eq(agents.id, lead)).get()
  return row !== undefined && row.runtime !== 'openclaw'
}

/** The team's Home settings, with whether its lead can write the line. */
export function homeSettingsFor(db: ClawbooDb, teamId: string) {
  return { ...getTeamHomeSettings(db, teamId), leadCanWriteStatus: leadCanWriteStatus(db, teamId) }
}
