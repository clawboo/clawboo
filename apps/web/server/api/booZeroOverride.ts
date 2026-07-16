// The Boo Zero OVERRIDE — the writer for `boo-zero:agent-id`, the runtime-NEUTRAL
// "Make this agent Boo Zero" designation that `resolveBooZero` has always read
// FIRST (override → native → OpenClaw) but which had no setter wired. It is what
// lets a NON-native agent (e.g. a Codex agent running on a ChatGPT subscription)
// lead every team in a MIXED install, where the default-native Boo Zero would
// otherwise always win. In a pure-coding install the override is unnecessary
// (`resolveBooZero` → null → `resolveLeaderId` falls to `team.leaderAgentId`).
//
// Clearing (agentId: null) restores the default resolution chain. Setting
// validates the agent EXISTS and is not archived — any runtime is legal by
// design (`resolveOverrideBooZero` does no runtime check) — so a stale id can
// never be stored (a deleted agent already fails resolution at read time, but
// refusing it at write time surfaces the mistake to the caller).

import type { Request, Response } from 'express'
import { agents, createDb, getSetting, setSetting } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { getDbPath } from '../lib/db'
import {
  resolveBooZero,
  resolveNativeBooZero,
  resolveOpenClawBooZero,
  SETTING_BOO_ZERO_OVERRIDE,
} from '../lib/teamChat/booZero'

/** Which rung of the resolution chain (override → native → OpenClaw) the
 *  effective Boo Zero came from. The distinction matters to writers: an
 *  override or a native Boo Zero is a DELIBERATE leader (a user designation /
 *  a connected native install), while the OpenClaw rung is the weak
 *  absence-of-anything-else fallback (the Gateway `main`) that a deliberate
 *  designation may legitimately outrank. */
function effectiveTier(
  db: ReturnType<typeof createDb>,
  overrideAgentId: string | null,
): 'override' | 'native' | 'openclaw' | null {
  if (overrideAgentId) return 'override'
  if (resolveNativeBooZero(db)) return 'native'
  if (resolveOpenClawBooZero(db)) return 'openclaw'
  return null
}

// ─── GET /api/boo-zero/override ──────────────────────────────────────────────
// Returns the stored override (null when unset) + the EFFECTIVE Boo Zero the
// resolution chain currently lands on (and which tier produced it), so a
// client can render both and a writer can decide whether promoting is safe.

export function booZeroOverrideGET(_req: Request, res: Response): void {
  try {
    const db = createDb(getDbPath())
    const overrideAgentId = getSetting(db, SETTING_BOO_ZERO_OVERRIDE) || null
    res.json({
      overrideAgentId,
      effective: resolveBooZero(db),
      tier: effectiveTier(db, overrideAgentId),
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/boo-zero/override ─────────────────────────────────────────────
// Body: { agentId: string | null } — null clears the override.

export function booZeroOverridePOST(req: Request, res: Response): void {
  const body = req.body as { agentId?: unknown } | undefined
  if (!body || typeof body !== 'object' || !('agentId' in body)) {
    res.status(400).json({ error: 'agentId is required (string to set, null to clear)' })
    return
  }
  const agentId = body.agentId
  if (agentId !== null && (typeof agentId !== 'string' || !agentId.trim())) {
    res.status(400).json({ error: 'agentId must be a non-empty string or null' })
    return
  }

  try {
    const db = createDb(getDbPath())
    if (agentId === null) {
      setSetting(db, SETTING_BOO_ZERO_OVERRIDE, '')
      res.json({ ok: true, overrideAgentId: null, effective: resolveBooZero(db) })
      return
    }

    const row = db
      .select({ id: agents.id, archivedAt: agents.archivedAt })
      .from(agents)
      .where(eq(agents.id, agentId.trim()))
      .get()
    if (!row || row.archivedAt) {
      res.status(404).json({ error: 'agent not found (or archived)' })
      return
    }

    setSetting(db, SETTING_BOO_ZERO_OVERRIDE, row.id)
    res.json({ ok: true, overrideAgentId: row.id, effective: resolveBooZero(db) })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
