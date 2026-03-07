import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import path from 'node:path'
import os from 'node:os'
import { createDb, skills } from '@clawboo/db'
import { eq, desc } from 'drizzle-orm'

function getDbPath(): string {
  return path.join(os.homedir(), '.openclaw', 'clawboo', 'clawboo.db')
}

// ─── GET /api/skills?agentId=<optional> ─────────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const agentId = req.nextUrl.searchParams.get('agentId')

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
      return NextResponse.json({ ok: true, skills: filtered })
    }

    return NextResponse.json({ ok: true, skills: rows })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err), skills: [] }, { status: 500 })
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const { id, name, source, category, trustScore, agentId, version, author } = body

  if (!id || !name || !source || !agentId) {
    return NextResponse.json(
      { ok: false, error: 'id, name, source, and agentId are required' },
      { status: 400 },
    )
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
      return NextResponse.json({ ok: true, skill: updated })
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

    return NextResponse.json({ ok: true, skill: rows[0] ?? null })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

// ─── DELETE /api/skills?id=<skillId>&agentId=<agentId> ──────────────────────

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const skillId = req.nextUrl.searchParams.get('id')
  const agentId = req.nextUrl.searchParams.get('agentId')

  if (!skillId || !agentId) {
    return NextResponse.json(
      { ok: false, error: 'id and agentId query params are required' },
      { status: 400 },
    )
  }

  try {
    const db = createDb(getDbPath())

    const existing = db.select().from(skills).where(eq(skills.id, skillId)).get()

    if (!existing) {
      return NextResponse.json({ ok: true, deleted: false, reason: 'skill not found' })
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
      return NextResponse.json({ ok: true, deleted: true, removedRow: true })
    }

    meta.agentIds = filtered
    db.update(skills)
      .set({ metadata: JSON.stringify(meta) })
      .where(eq(skills.id, skillId))
      .run()

    return NextResponse.json({ ok: true, deleted: true, removedRow: false })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
