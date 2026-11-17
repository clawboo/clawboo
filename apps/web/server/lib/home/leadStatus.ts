// Whether a team's lead can write the Home status line. The line is written with
// the Tasks tool `write_home_summary`, which only a Tasks session that is bound to
// its agent and team, and that is not read-only, is offered. Asking a lead that
// lacks it would spend a model call for nothing, so such a lead is never asked and
// the line cannot be turned on for its team. Why not, for the UI to say:
//
// - `no_lead`: the team has no lead.
// - `openclaw_lead`: an OpenClaw agent's Tasks tools carry no identity (an
//   unverified caller), so they never include Home's writes.
// - `tasks_read_only`: a Clawboo native lead whose board access is read-only, the
//   native default. A read-only Tasks session serves only reads.
// - `tasks_off`: a Clawboo native lead with board access off: no Tasks session.
//
// The coding runtimes (Codex, Claude Code, Hermes) get a signed, bound Tasks
// session on every team run, never a read-only one.

import { agents, getTeamHomeSettings, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { loadAgentConfigOrDefault } from '../runtimes/native/agentConfigStore'
import { resolveTeamLeadId } from '../teamChat/teamLead'

export type LeadCannotWriteReason = 'no_lead' | 'openclaw_lead' | 'tasks_read_only' | 'tasks_off'

/** Why the team's lead cannot write the status line, or null when it can. */
export function leadCannotWriteReason(db: ClawbooDb, teamId: string): LeadCannotWriteReason | null {
  const lead = resolveTeamLeadId(db, teamId)
  if (!lead) return 'no_lead'
  const row = db.select({ runtime: agents.runtime }).from(agents).where(eq(agents.id, lead)).get()
  if (!row) return 'no_lead'
  if (row.runtime === 'openclaw') return 'openclaw_lead'
  if (row.runtime === 'clawboo-native') {
    // The same read a native run makes to choose its Tasks session (nativeDriver).
    const tasks = loadAgentConfigOrDefault(db, lead).tools.tasks
    if (tasks === false) return 'tasks_off'
    if (tasks !== true) return 'tasks_read_only'
  }
  return null
}

export function leadCanWriteStatus(db: ClawbooDb, teamId: string): boolean {
  return leadCannotWriteReason(db, teamId) === null
}

/** The team's Home settings, with whether its lead can write the line and why not. */
export function homeSettingsFor(db: ClawbooDb, teamId: string) {
  const reason = leadCannotWriteReason(db, teamId)
  return {
    ...getTeamHomeSettings(db, teamId),
    leadCanWriteStatus: reason === null,
    leadCannotWriteReason: reason,
  }
}
