import type { Request, Response } from 'express'
import { createDb, graphLayouts } from '@clawboo/db'
import { and, eq } from 'drizzle-orm'
import { getDbPath } from '../lib/db'

interface LayoutData {
  positions: Record<string, { x: number; y: number }>
}

// ─── GET /api/graph-layout?name=default&url=<gatewayUrl> ─────────────────────

export async function graphLayoutGET(req: Request, res: Response): Promise<void> {
  const name = (req.query['name'] as string | undefined) ?? 'default'
  const gatewayUrl = (req.query['url'] as string | undefined) ?? ''

  try {
    const db = createDb(getDbPath())
    const rows = await db
      .select()
      .from(graphLayouts)
      .where(and(eq(graphLayouts.name, name), eq(graphLayouts.gatewayUrl, gatewayUrl)))
      .limit(1)

    if (rows.length === 0) {
      res.json({ positions: {} })
      return
    }

    const data = JSON.parse(rows[0]!.layoutData) as LayoutData
    res.json(data)
  } catch {
    res.json({ positions: {} })
  }
}

// ─── POST /api/graph-layout ───────────────────────────────────────────────────

export async function graphLayoutPOST(req: Request, res: Response): Promise<void> {
  type Body = { name?: string; positions: LayoutData['positions']; gatewayUrl: string }

  const body = req.body as Body | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'invalid JSON' })
    return
  }

  const name = body.name ?? 'default'
  const { positions, gatewayUrl } = body

  if (!gatewayUrl) {
    res.status(400).json({ ok: false, error: 'gatewayUrl required' })
    return
  }

  try {
    const db = createDb(getDbPath())
    const now = Date.now()
    const layoutData = JSON.stringify({ positions })

    await db
      .insert(graphLayouts)
      .values({ name, gatewayUrl, layoutData, createdAt: now, updatedAt: now })
      .onConflictDoUpdate({
        target: [graphLayouts.name, graphLayouts.gatewayUrl],
        set: { layoutData, updatedAt: now },
      })

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}
