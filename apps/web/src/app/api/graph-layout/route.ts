import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import path from 'node:path'
import os from 'node:os'
import { createDb } from '@clawboo/db'
import { graphLayouts } from '@clawboo/db'
import { and, eq } from 'drizzle-orm'
import type { LayoutData } from '@/features/graph/types'

function getDbPath(): string {
  return path.join(os.homedir(), '.openclaw', 'clawboo', 'clawboo.db')
}

// ─── GET /api/graph-layout?name=default&url=<gatewayUrl> ─────────────────────

export async function GET(req: NextRequest): Promise<NextResponse> {
  const name = req.nextUrl.searchParams.get('name') ?? 'default'
  const gatewayUrl = req.nextUrl.searchParams.get('url') ?? ''

  try {
    const db = createDb(getDbPath())
    const rows = await db
      .select()
      .from(graphLayouts)
      .where(and(eq(graphLayouts.name, name), eq(graphLayouts.gatewayUrl, gatewayUrl)))
      .limit(1)

    if (rows.length === 0) return NextResponse.json({ positions: {} })

    const data = JSON.parse(rows[0]!.layoutData) as LayoutData
    return NextResponse.json(data)
  } catch {
    return NextResponse.json({ positions: {} })
  }
}

// ─── POST /api/graph-layout ───────────────────────────────────────────────────

export async function POST(req: NextRequest): Promise<NextResponse> {
  type Body = { name?: string; positions: LayoutData['positions']; gatewayUrl: string }
  const body = (await req.json()) as Body

  const name = body.name ?? 'default'
  const { positions, gatewayUrl } = body

  if (!gatewayUrl) {
    return NextResponse.json({ ok: false, error: 'gatewayUrl required' }, { status: 400 })
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

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ ok: false, error: String(err) }, { status: 500 })
  }
}
