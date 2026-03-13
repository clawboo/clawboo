import type { Request, Response } from 'express'
import { createDb, skills } from '@clawboo/db'
import { eq, desc } from 'drizzle-orm'
import { getDbPath } from '../lib/db'

// ─── GET /api/skills?agentId=<optional> ─────────────────────────────────────

export function skillsGET(req: Request, res: Response): void {
  const agentId = req.query['agentId'] as string | undefined

  try {
    const db = createDb(getDbPath())
    const rows = db.select().from(skills).orderBy(desc(skills.installedAt)).all()

    if (agentId) {
      const filtered = rows.filter((row) => {
        if (!row.metadata) return false
        try {
          const meta = JSON.parse(row.metadata) as Record<string, unknown>
          return Array.isArray(meta.agentIds) && (meta.agentIds as string[]).includes(agentId)
        } catch {
          return false
        }
      })
      res.json({ ok: true, skills: filtered })
      return
    }

    res.json({ ok: true, skills: rows })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err), skills: [] })
  }
}

// ─── POST /api/skills — install a skill for an agent ────────────────────────

interface PostBody {
  id: string
  name: string
  source: string
  category?: string | null
  trustScore?: number | null
  agentId: string
  version?: string | null
  author?: string | null
}

export function skillsPOST(req: Request, res: Response): void {
  const body = req.body as PostBody | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Invalid JSON body' })
    return
  }

  const { id, name, source, category, trustScore, agentId, version, author } = body

  if (!id || !name || !source || !agentId) {
    res.status(400).json({ ok: false, error: 'id, name, source, and agentId are required' })
    return
  }

  const now = Date.now()

  try {
    const db = createDb(getDbPath())

    // Check if skill already exists
    const existing = db.select().from(skills).where(eq(skills.id, id)).get()

    if (existing) {
      // Merge agentId into existing metadata.agentIds
      let meta: Record<string, unknown> = {}
      if (existing.metadata) {
        try {
          meta = JSON.parse(existing.metadata) as Record<string, unknown>
        } catch {
          meta = {}
        }
      }

      const agentIds: string[] = Array.isArray(meta.agentIds) ? (meta.agentIds as string[]) : []
      if (!agentIds.includes(agentId)) {
        agentIds.push(agentId)
      }
      meta.agentIds = agentIds
      if (version) meta.version = version
      if (author) meta.author = author

      db.update(skills)
        .set({ metadata: JSON.stringify(meta) })
        .where(eq(skills.id, id))
        .run()

      const updated = db.select().from(skills).where(eq(skills.id, id)).get()
      res.json({ ok: true, skill: updated })
      return
    }

    // Insert new skill row
    const meta: Record<string, unknown> = { agentIds: [agentId] }
    if (version) meta.version = version
    if (author) meta.author = author

    const rows = db
      .insert(skills)
      .values({
        id,
        name,
        source,
        category: category ?? null,
        trustScore: trustScore ?? null,
        installedAt: now,
        metadata: JSON.stringify(meta),
      })
      .returning()
      .all()

    res.json({ ok: true, skill: rows[0] ?? null })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}

// ─── DELETE /api/skills?id=<skillId>&agentId=<agentId> ──────────────────────

export function skillsDELETE(req: Request, res: Response): void {
  const skillId = req.query['id'] as string | undefined
  const agentId = req.query['agentId'] as string | undefined

  if (!skillId || !agentId) {
    res.status(400).json({ ok: false, error: 'id and agentId query params are required' })
    return
  }

  try {
    const db = createDb(getDbPath())

    const existing = db.select().from(skills).where(eq(skills.id, skillId)).get()

    if (!existing) {
      res.json({ ok: true, deleted: false, reason: 'skill not found' })
      return
    }

    let meta: Record<string, unknown> = {}
    if (existing.metadata) {
      try {
        meta = JSON.parse(existing.metadata) as Record<string, unknown>
      } catch {
        meta = {}
      }
    }

    const agentIds: string[] = Array.isArray(meta.agentIds) ? (meta.agentIds as string[]) : []
    const filtered = agentIds.filter((id) => id !== agentId)

    if (filtered.length === 0) {
      db.delete(skills).where(eq(skills.id, skillId)).run()
      res.json({ ok: true, deleted: true, removedRow: true })
      return
    }

    meta.agentIds = filtered
    db.update(skills)
      .set({ metadata: JSON.stringify(meta) })
      .where(eq(skills.id, skillId))
      .run()

    res.json({ ok: true, deleted: true, removedRow: false })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}
