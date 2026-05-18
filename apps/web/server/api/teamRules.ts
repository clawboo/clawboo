// Team rules — durable per-team rules text persisted in the settings
// key/value table. The user captures rules either via the maintenance
// panel textarea OR via the `/rule <text>` slash command in the team
// chat composer; either path writes here.
//
// The rules text is injected into the message preamble for every team
// agent (and Boo Zero in team scope) so user corrections survive across
// sessions. Without this, rules like "don't do work yourself, delegate
// via <delegate>" rolled out of the last-8-messages context window
// within an hour and agents repeated the same mistakes.

import type { Request, Response } from 'express'
import { createDb, getSetting, setSetting } from '@clawboo/db'
import { getDbPath } from '../lib/db'

interface TeamRules {
  content: string
}

const DEFAULT_RULES: TeamRules = { content: '' }
const MAX_RULES_CHARS = 4000

function settingsKey(teamId: string): string {
  return `team-rules:${teamId}`
}

export function readTeamRules(db: ReturnType<typeof createDb>, teamId: string): TeamRules {
  const raw = getSetting(db, settingsKey(teamId))
  if (!raw) return { ...DEFAULT_RULES }
  try {
    const parsed = JSON.parse(raw) as Partial<TeamRules>
    return {
      content: typeof parsed.content === 'string' ? parsed.content : '',
    }
  } catch {
    return { ...DEFAULT_RULES }
  }
}

// ─── GET /api/team-rules/:teamId ─────────────────────────────────────────────

export function teamRulesGET(req: Request, res: Response): void {
  const teamId = req.params['teamId'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  try {
    const db = createDb(getDbPath())
    const rules = readTeamRules(db, teamId)
    res.json(rules)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PUT /api/team-rules/:teamId ─────────────────────────────────────────────
// Body: { content: string }. Capped at MAX_RULES_CHARS server-side.

interface PutBody {
  content?: string
}

export function teamRulesPUT(req: Request, res: Response): void {
  const teamId = req.params['teamId'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }
  const body = req.body as PutBody | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }
  if (typeof body.content !== 'string') {
    res.status(400).json({ error: 'content (string) required' })
    return
  }
  if (body.content.length > MAX_RULES_CHARS) {
    res.status(400).json({ error: `content exceeds ${MAX_RULES_CHARS} characters` })
    return
  }
  try {
    const db = createDb(getDbPath())
    const next: TeamRules = { content: body.content }
    setSetting(db, settingsKey(teamId), JSON.stringify(next))
    res.json(next)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
