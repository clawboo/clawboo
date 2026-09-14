import type { Request, Response } from 'express'
import { agents } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import { getDb } from '../lib/db'
import { getRegistry } from '../lib/agentSource'
import { applyExecApprovalPolicy, isExecAsk } from '../lib/agentSource/execApprovalPolicy'

// ─── GET /api/exec-settings?agentId=xxx ─────────────────────────────────────
// Returns the stored execution permission values for an agent, or null if none.

export function execSettingsGET(req: Request, res: Response): void {
  const agentId = req.query['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }

  try {
    const db = getDb()
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
    const db = getDb()
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

export async function execSettingsPOST(req: Request, res: Response): Promise<void> {
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
    const db = getDb()

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

    // ── And the half that actually gates anything ───────────────────────────
    //
    // The write above is clawboo's OWN record. It changes nothing about what a
    // Boo may run: the Gateway keeps its own policy and consults only that when
    // deciding whether to ask. Until now the Gateway write lived in the browser,
    // behind a connection check and a swallowed error, with the success message
    // shown regardless — so a tab with no Gateway connection reported "Saved"
    // while the Boo carried on running every command unasked.
    //
    // Doing it here removes the tab from the path entirely. The server's
    // connection is long-lived and reconnects on its own.
    const row = db
      .select({ sourceAgentId: agents.sourceAgentId, runtime: agents.runtime })
      .from(agents)
      .where(eq(agents.id, agentId))
      .get()

    // Only OpenClaw has a Gateway policy to write. For every other runtime the
    // local record IS the whole setting, so reporting a Gateway failure would be
    // inventing a problem.
    if (row?.runtime !== 'openclaw' || !row.sourceAgentId) {
      res.json({ ok: true, gateway: 'not-applicable' })
      return
    }
    if (!isExecAsk(values.execAsk)) {
      res.status(400).json({ error: `unknown execAsk: ${String(values.execAsk)}` })
      return
    }

    // OPENCLAW'S id, not clawboo's row id: the Gateway keys its policy by its own
    // ids, and a policy written under the wrong one is never consulted and never
    // complains.
    const applied = await applyExecApprovalPolicy(
      getRegistry().source,
      row.sourceAgentId,
      values.execAsk,
    )
    if (!applied.ok) {
      // 502 rather than 200. The caller asked for a permission change and did not
      // get one; saying "ok" here is the defect this replaces.
      res.status(502).json({
        ok: false,
        savedLocally: true,
        error: `saved in clawboo, but the Gateway did not accept it: ${applied.error ?? 'unknown'}`,
      })
      return
    }

    res.json({ ok: true, gateway: 'applied' })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
