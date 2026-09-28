// Display names for the merged schedule view, resolved at read time so a client
// can render a row without a second lookup. A team routine keeps no agent (its
// fire goes to whoever leads the team then), so its `agentName` and `runtime`
// are the team's current lead's: the agent that will actually receive the next
// fire.

import { agents, teams, type ClawbooDb } from '@clawboo/db'
import type { ScheduleRecord } from '@clawboo/scheduler'
import { inArray } from 'drizzle-orm'

import { resolveTeamLeadId } from '../teamChat/teamLead'

export function enrichScheduleRecords(db: ClawbooDb, records: ScheduleRecord[]): ScheduleRecord[] {
  const agentIds = new Set<string>()
  const teamIds = new Set<string>()
  const leadByTeam = new Map<string, string | null>()
  for (const r of records) {
    if (r.agentId) agentIds.add(r.agentId)
    if (r.teamId) teamIds.add(r.teamId)
    if (r.target === 'team' && r.teamId && !leadByTeam.has(r.teamId)) {
      const leadId = resolveTeamLeadId(db, r.teamId)
      leadByTeam.set(r.teamId, leadId)
      if (leadId) agentIds.add(leadId)
    }
  }

  const agentById = new Map<string, { name: string; runtime: string }>()
  if (agentIds.size > 0) {
    const rows = db
      .select({ id: agents.id, name: agents.name, runtime: agents.runtime })
      .from(agents)
      .where(inArray(agents.id, [...agentIds]))
      .all() as Array<{ id: string; name: string; runtime: string }>
    for (const row of rows) agentById.set(row.id, { name: row.name, runtime: row.runtime })
  }
  const teamNameById = new Map<string, string>()
  if (teamIds.size > 0) {
    const rows = db
      .select({ id: teams.id, name: teams.name })
      .from(teams)
      .where(inArray(teams.id, [...teamIds]))
      .all() as Array<{ id: string; name: string }>
    for (const row of rows) teamNameById.set(row.id, row.name)
  }

  return records.map((r) => {
    const out: ScheduleRecord = { ...r }
    const teamName = r.teamId ? teamNameById.get(r.teamId) : undefined
    if (teamName) out.teamName = teamName
    if (r.target === 'team') {
      const leadId = r.teamId ? leadByTeam.get(r.teamId) : null
      const lead = leadId ? agentById.get(leadId) : undefined
      if (lead) {
        out.agentName = lead.name
        out.runtime = lead.runtime
      }
    } else {
      const agent = r.agentId ? agentById.get(r.agentId) : undefined
      if (agent) out.agentName = agent.name
    }
    return out
  })
}
