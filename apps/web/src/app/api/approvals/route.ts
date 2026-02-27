import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import path from 'node:path'
import os from 'node:os'
import { createDb, approvalHistory } from '@clawboo/db'
import { desc, eq } from 'drizzle-orm'

function getDbPath(): string {
  return path.join(os.homedir(), '.openclaw', 'clawboo', 'clawboo.db')
}

// ─── POST /api/approvals — persist a decision ─────────────────────────────────

type PostBody = {
  agentId: string
  action: 'allow-once' | 'allow-always' | 'deny'
  toolName: string
  details?: Record<string, unknown> | null
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ ok: false, error: 'Invalid JSON body' }, { status: 400 })
  }

  const { agentId, action, toolName, details } = body

  if (!agentId || !action || !toolName) {
    return NextResponse.json(
      { ok: false, error: 'agentId, action, and toolName are required' },
      { status: 400 },
    )
  }

  const validActions = ['allow-once', 'allow-always', 'deny'] as const
  if (!(validActions as readonly string[]).includes(action)) {
    return NextResponse.json({ ok: false, error: 'Invalid action' }, { status: 400 })
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
    return NextResponse.json({ ok: true, record })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}

// ─── GET /api/approvals?agentId=<id>&limit=50 ────────────────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const agentId = req.nextUrl.searchParams.get('agentId')
  const limit = Math.min(200, Math.max(1, Number(req.nextUrl.searchParams.get('limit') ?? '50')))

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

    return NextResponse.json({ ok: true, records: rows })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err), records: [] }, { status: 500 })
  }
}
