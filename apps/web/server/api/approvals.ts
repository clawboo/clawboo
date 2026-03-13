import type { Request, Response } from 'express'
import { createDb, approvalHistory } from '@clawboo/db'
import { desc, eq } from 'drizzle-orm'
import { getDbPath } from '../lib/db'

// ─── POST /api/approvals — persist a decision ─────────────────────────────────

type PostBody = {
  agentId: string
  action: 'allow-once' | 'allow-always' | 'deny'
  toolName: string
  details?: Record<string, unknown> | null
}

export async function approvalsPOST(req: Request, res: Response): Promise<void> {
  const body = req.body as PostBody | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'Invalid JSON body' })
    return
  }

  const { agentId, action, toolName, details } = body

  if (!agentId || !action || !toolName) {
    res.status(400).json({ ok: false, error: 'agentId, action, and toolName are required' })
    return
  }

  const validActions = ['allow-once', 'allow-always', 'deny'] as const
  if (!(validActions as readonly string[]).includes(action)) {
    res.status(400).json({ ok: false, error: 'Invalid action' })
    return
  }

  try {
    const db = createDb(getDbPath())
    const now = Date.now()

    const inserted = await db
      .insert(approvalHistory)
      .values({
        agentId,
        action,
        toolName,
        details: details ? JSON.stringify(details) : null,
        createdAt: now,
      })
      .returning()

    const record = inserted[0] ?? null
    res.json({ ok: true, record })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err) })
  }
}

// ─── GET /api/approvals?agentId=<id>&limit=50 ────────────────────────────────

export async function approvalsGET(req: Request, res: Response): Promise<void> {
  const agentId = req.query['agentId'] as string | undefined
  const limit = Math.min(200, Math.max(1, Number(req.query['limit'] ?? '50')))

  try {
    const db = createDb(getDbPath())

    const rows = agentId
      ? await db
          .select()
          .from(approvalHistory)
          .where(eq(approvalHistory.agentId, agentId))
          .orderBy(desc(approvalHistory.createdAt))
          .limit(limit)
      : await db
          .select()
          .from(approvalHistory)
          .orderBy(desc(approvalHistory.createdAt))
          .limit(limit)

    res.json({ ok: true, records: rows })
  } catch (err) {
    res.status(500).json({ ok: false, error: String(err), records: [] })
  }
}
