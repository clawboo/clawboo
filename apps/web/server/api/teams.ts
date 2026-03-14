import crypto from 'node:crypto'
import type { Request, Response } from 'express'
import { createDb, teams, agents } from '@clawboo/db'
import { eq, sql } from 'drizzle-orm'
import { getDbPath } from '../lib/db'

// ─── GET /api/teams ──────────────────────────────────────────────────────────
// Returns all teams with an agentCount for each.

export function teamsGET(_req: Request, res: Response): void {
  try {
    const db = createDb(getDbPath())

    const rows = db
      .select({
        id: teams.id,
        name: teams.name,
        icon: teams.icon,
        color: teams.color,
        templateId: teams.templateId,
        createdAt: teams.createdAt,
        updatedAt: teams.updatedAt,
        agentCount: sql<number>`(SELECT COUNT(*) FROM agents WHERE agents.team_id = ${teams.id})`,
      })
      .from(teams)
      .all()

    res.json({ teams: rows })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/teams ─────────────────────────────────────────────────────────
// Body: { name: string, icon: string, color: string, templateId?: string }

interface CreateBody {
  name: string
  icon: string
  color: string
  templateId?: string
}

export function teamsPOST(req: Request, res: Response): void {
  const body = req.body as CreateBody | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }

  const { name, icon, color, templateId } = body
  if (!name || !icon || !color) {
    res.status(400).json({ error: 'name, icon, and color are required' })
    return
  }

  const now = Date.now()
  const id = crypto.randomUUID()

  try {
    const db = createDb(getDbPath())

    db.insert(teams)
      .values({
        id,
        name,
        icon,
        color,
        templateId: templateId ?? null,
        createdAt: now,
        updatedAt: now,
      })
      .run()

    res.json({
      team: {
        id,
        name,
        icon,
        color,
        templateId: templateId ?? null,
        agentCount: 0,
        createdAt: now,
        updatedAt: now,
      },
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── PATCH /api/teams/:id ────────────────────────────────────────────────────
// Body: partial { name?, icon?, color? }

interface PatchBody {
  name?: string
  icon?: string
  color?: string
}

export function teamsPATCH(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }

  const body = req.body as PatchBody | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }

  try {
    const db = createDb(getDbPath())

    const existing = db.select().from(teams).where(eq(teams.id, teamId)).get()
    if (!existing) {
      res.status(404).json({ error: 'team not found' })
      return
    }

    const now = Date.now()
    const patch: Record<string, unknown> = { updatedAt: now }
    if (body.name !== undefined) patch['name'] = body.name
    if (body.icon !== undefined) patch['icon'] = body.icon
    if (body.color !== undefined) patch['color'] = body.color

    db.update(teams).set(patch).where(eq(teams.id, teamId)).run()

    const updated = db
      .select({
        id: teams.id,
        name: teams.name,
        icon: teams.icon,
        color: teams.color,
        templateId: teams.templateId,
        createdAt: teams.createdAt,
        updatedAt: teams.updatedAt,
        agentCount: sql<number>`(SELECT COUNT(*) FROM agents WHERE agents.team_id = ${teams.id})`,
      })
      .from(teams)
      .where(eq(teams.id, teamId))
      .get()

    res.json({ team: updated })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── DELETE /api/teams/:id ───────────────────────────────────────────────────
// Deletes the team and orphans its agents (sets teamId = null).

export function teamsDELETE(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }

  try {
    const db = createDb(getDbPath())

    // Orphan agents belonging to this team
    db.update(agents).set({ teamId: null }).where(eq(agents.teamId, teamId)).run()

    // Delete the team
    db.delete(teams).where(eq(teams.id, teamId)).run()

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/teams/:id/agents ──────────────────────────────────────────────
// Body: { agentId: string }
// Assigns an agent to a team.

export function teamAgentPOST(req: Request, res: Response): void {
  const teamId = req.params['id'] as string | undefined
  if (!teamId) {
    res.status(400).json({ error: 'team id required' })
    return
  }

  const body = req.body as { agentId?: string } | undefined
  if (!body || typeof body !== 'object' || !body.agentId) {
    res.status(400).json({ error: 'agentId is required' })
    return
  }

  try {
    const db = createDb(getDbPath())

    db.update(agents).set({ teamId }).where(eq(agents.id, body.agentId)).run()

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── DELETE /api/teams/:id/agents/:agentId ───────────────────────────────────
// Removes an agent from a team (sets teamId = null).

export function teamAgentDELETE(req: Request, res: Response): void {
  const agentId = req.params['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }

  try {
    const db = createDb(getDbPath())

    db.update(agents).set({ teamId: null }).where(eq(agents.id, agentId)).run()

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
