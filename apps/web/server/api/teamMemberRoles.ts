// GET /api/teams/member-roles: the one-line role each live team member states in
// its SOUL.md, so the board's New task dialog can suggest who fits a sentence.
// Returns `{ roles: { [agentId]: role } }`. Read with the same reader as the team
// lead's roster, so an agent with no role there (OpenClaw, no persona, the shipped
// default prompt) is left out. A pure read.

import type { Request, Response } from 'express'
import { agents } from '@clawboo/db'
import { isNotNull } from 'drizzle-orm'

import { getDb } from '../lib/db'
import { readTeammateRole } from '../lib/teamChat/teammateRoles'

export function teamMemberRolesGET(_req: Request, res: Response): void {
  try {
    const db = getDb()
    const members = db
      .select({
        id: agents.id,
        name: agents.name,
        runtime: agents.runtime,
        archivedAt: agents.archivedAt,
      })
      .from(agents)
      .where(isNotNull(agents.teamId))
      .all()
    const roles: Record<string, string> = {}
    for (const member of members) {
      if (member.archivedAt) continue
      const role = readTeammateRole(db, member)
      if (role) roles[member.id] = role
    }
    res.json({ roles })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
