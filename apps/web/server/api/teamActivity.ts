// GET /api/teams/:id/activity-summary — a compact server-built snapshot of what a
// team has been doing (its Boo-Zero brief + board + recent team chat), for injection
// into Boo Zero's PERSONAL chat when the user `@`-mentions that team. Returns
// `{ content: string | null }` (null = the team has no reportable activity). A pure
// read; never 500s on an empty/unknown team.

import { createDb } from '@clawboo/db'
import type { Request, Response } from 'express'

import { getDbPath } from '../lib/db'
import { buildTeamActivitySummary } from '../lib/teamChat/teamActivitySummary'

export async function teamActivitySummaryGET(req: Request, res: Response): Promise<void> {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  try {
    const db = createDb(getDbPath())
    const content = await buildTeamActivitySummary(db, teamId)
    res.json({ content })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
