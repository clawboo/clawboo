import type { Request, Response } from 'express'
import { createDb, agents } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import { getDbPath } from '../lib/db'

// ─── Storage format ──────────────────────────────────────────────────────────
// The personalityConfig column stores JSON as a `{ values, customText }` wrapper:
//   { values: { verbosity: 50, humor: 50, ... }, customText: "..." | null }
// The POST handler writes this shape; the GET handler reads it.

interface StoredConfig {
  values: Record<string, number>
  customText: string | null
}

/** Parse the stored JSON wrapper; null on a corrupt / unexpected blob. */
export function parseStoredConfig(raw: string): StoredConfig | null {
  try {
    const parsed = JSON.parse(raw)
    if (!parsed || typeof parsed !== 'object') return null
    if (parsed.values && typeof parsed.values === 'object' && !Array.isArray(parsed.values)) {
      return {
        values: parsed.values as Record<string, number>,
        customText: typeof parsed.customText === 'string' ? parsed.customText : null,
      }
    }
    return null
  } catch {
    return null
  }
}

// ─── GET /api/personality?agentId=xxx ────────────────────────────────────────
// Returns the stored personality slider values and optional custom text for an agent.

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
      res.json({ values: null, customText: null })
      return
    }

    const config = parseStoredConfig(row.personalityConfig)
    if (!config) {
      res.json({ values: null, customText: null })
      return
    }

    res.json({ values: config.values, customText: config.customText })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/personality ───────────────────────────────────────────────────
// Body: { agentId: string, values: { verbosity, humor, ... }, customText?: string | null }
// Upserts the agent row and sets personality_config.

type PostBody = {
  agentId: string
  values: Record<string, number>
  customText?: string | null
}

export function personalityPOST(req: Request, res: Response): void {
  const body = req.body as PostBody | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }

  const { agentId, values, customText } = body
  if (!agentId || !values) {
    res.status(400).json({ error: 'agentId and values required' })
    return
  }

  const now = Date.now()
  const config: StoredConfig = {
    values,
    customText: typeof customText === 'string' && customText.trim() ? customText.trim() : null,
  }
  const personalityConfig = JSON.stringify(config)

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
