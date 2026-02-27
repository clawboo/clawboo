import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import path from 'node:path'
import os from 'node:os'
import { createDb, costRecords, agents } from '@clawboo/db'
import { eq, gte, and, desc } from 'drizzle-orm'
import { calculateCostUsd } from '@/features/cost/costUtils'

function getDbPath(): string {
  return path.join(os.homedir(), '.openclaw', 'clawboo', 'clawboo.db')
}

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

export async function GET(req: NextRequest): Promise<NextResponse> {
  const period = req.nextUrl.searchParams.get('period') ?? ''
  const agentId = req.nextUrl.searchParams.get('agentId') ?? ''

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

    return NextResponse.json({ records: rows })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  const { agentId, model, inputTokens, outputTokens, runId } = body
  if (!agentId || !model || inputTokens == null || outputTokens == null) {
    return NextResponse.json(
      { error: 'agentId, model, inputTokens, outputTokens required' },
      { status: 400 },
    )
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

    return NextResponse.json({ ok: true, record: inserted })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
