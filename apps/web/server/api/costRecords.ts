import type { Request, Response } from 'express'
import { createDb, costRecords, agents } from '@clawboo/db'
import { eq, gte, and, desc } from 'drizzle-orm'
import { getDbPath } from '../lib/db'
import { calculateCostUsd } from '../lib/costUtils'

function periodStart(period: string): number {
  const now = new Date()
  switch (period) {
    case 'today': {
      const d = new Date(now.getFullYear(), now.getMonth(), now.getDate())
      return d.getTime()
    }
    case 'week': {
      const d = new Date(now)
      d.setDate(d.getDate() - 7)
      return d.getTime()
    }
    case 'month': {
      const d = new Date(now)
      d.setDate(d.getDate() - 30)
      return d.getTime()
    }
    default:
      return 0
  }
}

// ─── GET /api/cost-records?period=today|week|month&agentId=xxx ────────────────

export async function costRecordsGET(req: Request, res: Response): Promise<void> {
  const period = (req.query['period'] as string | undefined) ?? ''
  const agentId = (req.query['agentId'] as string | undefined) ?? ''

  try {
    const db = createDb(getDbPath())
    const since = period ? periodStart(period) : 0

    const conditions = []
    if (since > 0) conditions.push(gte(costRecords.createdAt, since))
    if (agentId) conditions.push(eq(costRecords.agentId, agentId))

    const rows = await db
      .select()
      .from(costRecords)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(costRecords.createdAt))
      .limit(500)

    res.json({ records: rows })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/cost-records ───────────────────────────────────────────────────
// Body: { agentId, model, inputTokens, outputTokens, runId? }

type PostBody = {
  agentId: string
  model: string
  inputTokens: number
  outputTokens: number
  runId?: string | null
}

export async function costRecordsPOST(req: Request, res: Response): Promise<void> {
  const body = req.body as PostBody | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }

  const { agentId, model, inputTokens, outputTokens, runId } = body
  if (!agentId || !model || inputTokens == null || outputTokens == null) {
    res.status(400).json({ error: 'agentId, model, inputTokens, outputTokens required' })
    return
  }

  const costUsd = calculateCostUsd(model, inputTokens, outputTokens)
  const now = Date.now()

  try {
    const db = createDb(getDbPath())

    // Ensure agent row exists — FK on costRecords.agentId requires this
    await db
      .insert(agents)
      .values({
        id: agentId,
        name: agentId,
        gatewayId: agentId,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoNothing()

    const [inserted] = await db
      .insert(costRecords)
      .values({
        agentId,
        model,
        inputTokens,
        outputTokens,
        costUsd,
        runId: runId ?? null,
        createdAt: now,
      })
      .returning()

    res.json({ ok: true, record: inserted })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
