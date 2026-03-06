import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import path from 'node:path'
import os from 'node:os'
import { createDb, agents } from '@clawboo/db'
import { eq } from 'drizzle-orm'

function getDbPath(): string {
  return path.join(os.homedir(), '.openclaw', 'clawboo', 'clawboo.db')
}

// ─── GET /api/personality?agentId=xxx ────────────────────────────────────────
// Returns the stored personality slider values for an agent, or null if none saved.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const agentId = req.nextUrl.searchParams.get('agentId')
  if (!agentId) {
    return NextResponse.json({ error: 'agentId required' }, { status: 400 })
  }

  try {
    const db = createDb(getDbPath())
    const row = db
      .select({ personalityConfig: agents.personalityConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get() as { personalityConfig: string | null } | undefined

    if (!row || !row.personalityConfig) {
      return NextResponse.json({ values: null })
    }

    return NextResponse.json({ values: JSON.parse(row.personalityConfig) })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// ─── POST /api/personality ───────────────────────────────────────────────────
// Body: { agentId: string, values: { verbosity, humor, caution, speed_cost, formality } }
// Upserts the agent row and sets personality_config.

type PostBody = {
  agentId: string
  values: Record<string, number>
}

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  const { agentId, values } = body
  if (!agentId || !values) {
    return NextResponse.json({ error: 'agentId and values required' }, { status: 400 })
  }

  const now = Date.now()
  const personalityConfig = JSON.stringify(values)

  try {
    const db = createDb(getDbPath())

    // Ensure agent row exists (may not yet if no cost records have been created)
    db.insert(agents)
      .values({
        id: agentId,
        name: agentId,
        gatewayId: agentId,
        personalityConfig,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: { personalityConfig, updatedAt: now },
      })
      .run()

    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
