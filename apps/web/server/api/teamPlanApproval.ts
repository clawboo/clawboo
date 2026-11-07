// GET/PUT for a team's "ask me before splitting work" switch: whether a plan waits for a
// person before any of its steps start (see planApprovalOn in @clawboo/db). Off at first.
// A person's switch, so its write takes the person check, and each change is on record.

import { appendAudit, planApprovalOn, planApprovalSettingKey, setSetting, teams } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'

import { actorField, refuseUnlessPerson } from '../lib/auth'
import { getDb } from '../lib/db'

// ─── GET /api/team-plan-approval/:teamId ─────────────────────────────────────

export function teamPlanApprovalGET(req: Request, res: Response): void {
  const teamId = req.params['teamId'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  try {
    res.json({ on: planApprovalOn(getDb(), teamId) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PUT /api/team-plan-approval/:teamId ─────────────────────────────────────
// Body: { on: boolean }. Plans already waiting keep waiting: this changes what happens
// to the next plan, and a person can still answer those.

export function teamPlanApprovalPUT(req: Request, res: Response): void {
  if (refuseUnlessPerson(req, res)) return
  const teamId = req.params['teamId'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  const on = (req.body as { on?: unknown } | undefined)?.on
  if (typeof on !== 'boolean') {
    res.status(400).json({ error: 'on (boolean) required' })
    return
  }
  try {
    const db = getDb()
    if (!db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).get()) {
      res.status(404).json({ error: 'team not found' })
      return
    }
    const previous = planApprovalOn(db, teamId)
    setSetting(db, planApprovalSettingKey(teamId), JSON.stringify({ on }))
    appendAudit(db, {
      eventType: 'board',
      teamId,
      summary: { action: 'set_team_plan_approval', on, previous, ...actorField(req) },
    })
    res.json({ on })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
