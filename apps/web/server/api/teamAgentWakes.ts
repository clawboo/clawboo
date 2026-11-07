// GET/PUT for a team's "always allow": may its agents wake each other without a person
// being asked once per job? (see @clawboo/db board/agentWakes). Beside the team's work
// check, and with the same limit: the dashboard's own page is a speed bump locally, not
// a boundary against an agent that runs as the same user.

import type { Request, Response } from 'express'
import { appendAudit, readTeamAlwaysAllow, setTeamAlwaysAllow, teams } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { personField } from '../lib/auth'
import { getDb } from '../lib/db'
import { isDashboardRequest } from '../lib/dashboardRequest'

// ─── GET /api/team-agent-wakes/:teamId ───────────────────────────────────────

export function teamAgentWakesGET(req: Request, res: Response): void {
  const teamId = req.params['teamId'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  try {
    res.json({ always: readTeamAlwaysAllow(getDb(), teamId) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PUT /api/team-agent-wakes/:teamId ───────────────────────────────────────
// Body: { always: boolean }. A person's call, and each change is on record.

export function teamAgentWakesPUT(req: Request, res: Response): void {
  if (!isDashboardRequest(req)) {
    res.status(403).json({ ok: false, error: 'dashboard_only' })
    return
  }
  const teamId = req.params['teamId'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  const body = req.body as { always?: unknown } | undefined
  if (!body || typeof body.always !== 'boolean') {
    res.status(400).json({ error: 'always (boolean) required' })
    return
  }
  try {
    const db = getDb()
    if (!db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).get()) {
      res.status(404).json({ error: 'team not found' })
      return
    }
    setTeamAlwaysAllow(db, teamId, body.always)
    appendAudit(db, {
      eventType: 'board',
      teamId,
      summary: { agentWakesAlways: body.always, ...personField(req) },
    })
    res.json({ always: body.always })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
