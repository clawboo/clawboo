import type { Request, Response } from 'express'
import { createDb, agents } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import { getDbPath } from '../lib/db'

// ─── GET /api/exec-settings?agentId=xxx ─────────────────────────────────────
// Returns the stored execution permission values for an agent, or null if none.

export function execSettingsGET(req: Request, res: Response): void {
  const agentId = req.query['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }

  try {
    const db = createDb(getDbPath())
    const row = db
      .select({ execConfig: agents.execConfig })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get() as { execConfig: string | null } | undefined

    if (!row || !row.execConfig) {
      res.json({ values: null })
      return
    }

    res.json({ values: JSON.parse(row.execConfig) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── GET /api/exec-settings/all ──────────────────────────────────────────────
// Returns exec configs for all agents as a map. Used during fleet hydration.

export function execSettingsAllGET(_req: Request, res: Response): void {
  try {
    const db = createDb(getDbPath())
    const rows = db.select({ id: agents.id, execConfig: agents.execConfig }).from(agents).all() as {
      id: string
      execConfig: string | null
    }[]

    const configs: Record<string, { execAsk: string }> = {}
    for (const row of rows) {
      if (!row.execConfig) continue
      try {
        const parsed = JSON.parse(row.execConfig) as Record<string, unknown>
        if (parsed && typeof parsed['execAsk'] === 'string') {
          configs[row.id] = { execAsk: parsed['execAsk'] as string }
        }
      } catch {
        // Skip malformed JSON
      }
    }
    res.json({ configs })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/exec-settings ────────────────────────────────────────────────
// Body: { agentId: string, values: { execAsk: string; execSecurity?: string } }
// Upserts the agent row and sets exec_config.

type PostBody = {
  agentId: string
  values: { execAsk: string; execSecurity?: string }
}

export function execSettingsPOST(req: Request, res: Response): void {
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
  const execConfig = JSON.stringify(values)

  try {
    const db = createDb(getDbPath())

    // Ensure agent row exists (may not yet if no other data has been created)
    db.insert(agents)
      .values({
        id: agentId,
        name: agentId,
        gatewayId: agentId,
        execConfig,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: agents.id,
        set: { execConfig, updatedAt: now },
      })
      .run()

    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
