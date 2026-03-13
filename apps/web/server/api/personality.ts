import type { Request, Response } from 'express'
import { createDb, agents } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import { getDbPath } from '../lib/db'

// ─── GET /api/personality?agentId=xxx ────────────────────────────────────────
// Returns the stored personality slider values for an agent, or null if none saved.

export function personalityGET(req: Request, res: Response): void {
  const agentId = req.query['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }

  try {
    const db = createDb(getDbPath())
    const row = db
      .select({ personalityConfig: agents.personalityConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get() as { personalityConfig: string | null } | undefined

    if (!row || !row.personalityConfig) {
      res.json({ values: null })
      return
    }

    res.json({ values: JSON.parse(row.personalityConfig) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/personality ───────────────────────────────────────────────────
// Body: { agentId: string, values: { verbosity, humor, caution, speed_cost, formality } }
// Upserts the agent row and sets personality_config.

type PostBody = {
  agentId: string
  values: Record<string, number>
}

export function personalityPOST(req: Request, res: Response): void {
  const body = req.body as PostBody | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }

  const { agentId, values } = body
  if (!agentId || !values) {
    res.status(400).json({ error: 'agentId and values required' })
    return
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

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
