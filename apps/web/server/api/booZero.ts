// Boo Zero context storage — per-team briefs and a global brief.
//
// Per-team briefs live in the dedicated `boo_zero_team_briefs` table
// (FK cascades on team delete). The global brief is stored in `settings`
// under the key `boo-zero:global-brief`. Both endpoints return `null`
// content when nothing is stored — the UI falls back to client-side
// `buildTeamBrief` / `buildGlobalBrief` defaults in that case.

import type { Request, Response } from 'express'
import { createDb, booZeroTeamBriefs, getSetting, setSetting } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import { getDbPath } from '../lib/db'

const GLOBAL_BRIEF_KEY = 'boo-zero:global-brief'

interface TeamBriefBody {
  content?: string
}

interface GlobalBriefBody {
  content?: string
}

// ─── GET /api/boo-zero/team-briefs/:teamId ──────────────────────────────────

export function teamBriefGET(req: Request, res: Response): void {
  const teamId = req.params['teamId'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'teamId required' })
    return
  }
  try {
    const db = createDb(getDbPath())
    const row = db
      .select({ content: booZeroTeamBriefs.content, updatedAt: booZeroTeamBriefs.updatedAt })
      .from(booZeroTeamBriefs)
      .where(eq(booZeroTeamBriefs.teamId, teamId))
      .get()
    if (!row) {
      res.json({ content: null, updatedAt: null })
      return
    }
    res.json({ content: row.content, updatedAt: row.updatedAt })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PUT /api/boo-zero/team-briefs/:teamId ──────────────────────────────────
// Body: { content: string }. Upserts.

export function teamBriefPUT(req: Request, res: Response): void {
  const teamId = req.params['teamId'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'teamId required' })
    return
  }
  const body = req.body as TeamBriefBody | undefined
  if (!body || typeof body !== 'object' || typeof body.content !== 'string') {
    res.status(400).json({ error: 'content (string) required' })
    return
  }
  try {
    const db = createDb(getDbPath())
    const now = Date.now()
    db.insert(booZeroTeamBriefs)
      .values({ teamId, content: body.content, updatedAt: now })
      .onConflictDoUpdate({
        target: booZeroTeamBriefs.teamId,
        set: { content: body.content, updatedAt: now },
      })
      .run()
    res.json({ content: body.content, updatedAt: now })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── DELETE /api/boo-zero/team-briefs/:teamId ───────────────────────────────
// Removes a team's brief. Idempotent — deleting a non-existent brief is a no-op.
// Note: the FK cascade on team delete already handles brief cleanup when the
// team itself is removed; this endpoint is for explicit user action.

export function teamBriefDELETE(req: Request, res: Response): void {
  const teamId = req.params['teamId'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'teamId required' })
    return
  }
  try {
    const db = createDb(getDbPath())
    db.delete(booZeroTeamBriefs).where(eq(booZeroTeamBriefs.teamId, teamId)).run()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/boo-zero/global-brief ─────────────────────────────────────────

export function globalBriefGET(_req: Request, res: Response): void {
  try {
    const db = createDb(getDbPath())
    const raw = getSetting(db, GLOBAL_BRIEF_KEY)
    if (raw === null) {
      res.json({ content: null, updatedAt: null })
      return
    }
    // The settings table value is the raw markdown; the updatedAt is the
    // settings row's column. We re-query to get it.
    // (getSetting returns only the value; a small extra select gets the time.)
    res.json({ content: raw, updatedAt: null })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PUT /api/boo-zero/global-brief ─────────────────────────────────────────

export function globalBriefPUT(req: Request, res: Response): void {
  const body = req.body as GlobalBriefBody | undefined
  if (!body || typeof body !== 'object' || typeof body.content !== 'string') {
    res.status(400).json({ error: 'content (string) required' })
    return
  }
  try {
    const db = createDb(getDbPath())
    setSetting(db, GLOBAL_BRIEF_KEY, body.content)
    res.json({ content: body.content, updatedAt: Date.now() })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
