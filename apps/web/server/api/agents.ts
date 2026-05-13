import type { Request, Response } from 'express'
import { createDb, agents, costRecords, approvalHistory } from '@clawboo/db'
import { eq, sql, inArray } from 'drizzle-orm'
import { getDbPath } from '../lib/db'

// ─── DELETE /api/agents/:agentId ─────────────────────────────────────────────
//
// Removes an agent row from the LOCAL SQLite DB (Clawboo's own metadata) plus
// any FK-referenced rows that would otherwise block the delete:
//   - cost_records.agent_id  → ON DELETE NO ACTION (no cascade), so must
//     remove first to satisfy FK.
//   - approval_history.agent_id → same.
//
// The Gateway-side `agents.delete` RPC is the caller's responsibility (see
// `deleteAgentOperation` on the client). This endpoint ONLY cleans up local
// metadata; without it, deleted agents leave permanent ghost rows in SQLite
// that inflate per-team `agentCount` and pollute namespace checks.

export function agentsDELETE(req: Request, res: Response): void {
  const agentId = req.params['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }
  try {
    const db = createDb(getDbPath())
    // Order matters — children before parent.
    db.delete(costRecords).where(eq(costRecords.agentId, agentId)).run()
    db.delete(approvalHistory).where(eq(approvalHistory.agentId, agentId)).run()
    db.delete(agents).where(eq(agents.id, agentId)).run()
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/agents/cleanup-ghosts ─────────────────────────────────────────
//
// Body: { liveAgentIds: string[] }
//
// One-shot cleanup the client invokes after hydrating from the Gateway. The
// caller passes the IDs of all agents currently alive in the Gateway; this
// endpoint deletes every local SQLite agent row NOT in that list, plus their
// FK-referenced cost/approval rows. Idempotent — safe to call repeatedly.
//
// This catches historical pollution from a time when `deleteAgentOperation`
// only deleted the Gateway-side agent and left the SQLite row behind. Going
// forward, the per-agent DELETE endpoint above prevents accumulation.

interface CleanupBody {
  liveAgentIds: string[]
}

export function agentsCleanupPOST(req: Request, res: Response): void {
  const body = req.body as CleanupBody | undefined
  if (!body || !Array.isArray(body.liveAgentIds)) {
    res.status(400).json({ error: 'liveAgentIds array required' })
    return
  }
  // Guard rail: if the caller passes an empty list AND no agents are
  // actually expected to be alive, that's plausible. But if it's empty
  // because of a transient Gateway hiccup, we'd nuke every local row.
  // Require an explicit override flag for the empty-list case.
  if (body.liveAgentIds.length === 0 && !(req.query['allowEmpty'] === 'true')) {
    res.status(400).json({
      error: 'empty liveAgentIds list — pass ?allowEmpty=true to confirm',
    })
    return
  }

  try {
    const db = createDb(getDbPath())
    const liveIds = body.liveAgentIds

    // Collect IDs of local agent rows that are NOT in the live set.
    const localRows = db.select({ id: agents.id }).from(agents).all()
    const liveSet = new Set(liveIds)
    const toDelete = localRows.map((r) => r.id).filter((id) => !liveSet.has(id))

    if (toDelete.length === 0) {
      res.json({ ok: true, deleted: 0 })
      return
    }

    // Children before parent (FK guards).
    db.delete(costRecords).where(inArray(costRecords.agentId, toDelete)).run()
    db.delete(approvalHistory).where(inArray(approvalHistory.agentId, toDelete)).run()
    db.delete(agents).where(inArray(agents.id, toDelete)).run()

    // Sanity-log how many remain — useful when debugging via curl.
    const remaining = db
      .select({ count: sql<number>`COUNT(*)` })
      .from(agents)
      .all()[0]
    res.json({ ok: true, deleted: toDelete.length, remaining: remaining?.count ?? null })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
