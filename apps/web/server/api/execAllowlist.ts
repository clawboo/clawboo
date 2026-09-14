// ─── Standing exec grants: read and revoke ────────────────────────────────
//
// The half of the permissions control that was missing. An operator could mint a
// standing grant by answering "Always" to a command prompt, and had no way to see
// one afterwards, let alone take it back.
//
// AN EMPTY LIST IS A SAFETY CLAIM, so these routes never produce one by accident.
// A Gateway that cannot be reached, a policy document that cannot be parsed, and a
// Boo that genuinely has no grants are three different answers, and collapsing any
// of them into "nothing here" tells an operator their agent is gated when it is
// not. Each gets its own shape, and the reader refuses to guess between them.
//
// THE READ DOES NOT TOUCH THE GATEWAY. `exec.approvals.get` is a write; see
// `openclawExecAllowlistRead.ts` for what that costs. Only the revoke talks to it.

import { agents } from '@clawboo/db'
import { revokeExecAllowlistEntries } from '@clawboo/gateway-client'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'

import { getRegistry } from '../lib/agentSource'
import { readOpenClawExecAllowlist } from '../lib/agentSource/openclawExecAllowlistRead'
import { getDb } from '../lib/db'
import { redactValue } from '../lib/redact'

/** clawboo's row id resolved to the id the Gateway keys its policy by. */
function resolveOpenClawAgent(
  agentId: string,
): { runtime: string | null; sourceAgentId: string | null } | null {
  const row = getDb()
    .select({ runtime: agents.runtime, sourceAgentId: agents.sourceAgentId })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  return row ?? null
}

// GET /api/exec-allowlist?agentId=...
export function execAllowlistGET(req: Request, res: Response): void {
  try {
    const agentId = typeof req.query['agentId'] === 'string' ? req.query['agentId'] : ''
    if (!agentId) {
      res.status(400).json({ error: 'agentId required' })
      return
    }

    const row = resolveOpenClawAgent(agentId)
    if (!row) {
      res.status(404).json({ error: 'agent not found' })
      return
    }
    // Only OpenClaw keeps this document. For every other runtime there is no
    // standing-grant store to show, and rendering an empty list would imply one
    // exists and happens to be empty.
    if (row.runtime !== 'openclaw' || !row.sourceAgentId) {
      res.json({ state: 'not-applicable', runtime: row.runtime })
      return
    }

    const result = readOpenClawExecAllowlist(row.sourceAgentId)
    if (result.state === 'ok') {
      res.json({ state: 'ok', sourceAgentId: row.sourceAgentId, ...result.snapshot })
      return
    }
    if (result.state === 'absent') {
      // No policy document anywhere on this machine. Genuinely nothing granted,
      // to anyone, which is the one honest empty.
      res.json({ state: 'absent', sourceAgentId: row.sourceAgentId })
      return
    }
    // NO `entries` KEY AT ALL on this branch, deliberately. A client that
    // destructures a default of `[]` would render an empty list over a document
    // whose grants are still on disk and still being enforced.
    res.status(502).json({
      state: 'unreadable',
      sourceAgentId: row.sourceAgentId,
      error: redactValue(result.reason),
      knownAgentCount: result.knownAgentCount,
      knownAllowlistCount: result.knownAllowlistCount,
    })
  } catch (err) {
    res.status(500).json({ error: redactValue(String(err)) })
  }
}

/** Hand-rolled to match `execSettings.ts`; apps/web does not depend on zod. */
function parseRevokeBody(raw: unknown): { agentId: string; keys: string[] } | null {
  if (!raw || typeof raw !== 'object') return null
  const b = raw as Record<string, unknown>
  const agentId = typeof b['agentId'] === 'string' ? b['agentId'].trim() : ''
  const rawKeys = b['keys']
  if (!agentId || !Array.isArray(rawKeys) || rawKeys.length === 0) return null
  // Capped because every key widens a rewrite of the fleet's whole permissions
  // document, and an unbounded list is an unbounded payload to the Gateway.
  if (rawKeys.length > 200) return null
  const keys = rawKeys.filter((k): k is string => typeof k === 'string' && k.length > 0)
  if (keys.length !== rawKeys.length) return null
  return { agentId, keys }
}

// POST /api/exec-allowlist/revoke { agentId, keys }
export async function execAllowlistRevokePOST(req: Request, res: Response): Promise<void> {
  try {
    const parsed = parseRevokeBody(req.body)
    if (!parsed) {
      res.status(400).json({ error: 'agentId and a non-empty keys array are required' })
      return
    }

    const row = resolveOpenClawAgent(parsed.agentId)
    if (!row) {
      res.status(404).json({ error: 'agent not found' })
      return
    }
    if (row.runtime !== 'openclaw' || !row.sourceAgentId) {
      res.status(400).json({ error: 'this runtime keeps no standing exec grants' })
      return
    }

    const source = getRegistry().source
    const outcome = await revokeExecAllowlistEntries(
      { call: (method, params) => source.operatorCall(method, params) },
      { agentId: row.sourceAgentId, keys: parsed.keys },
    )

    // EVERY OUTCOME GETS ITS OWN STATUS. A bare `ok` would let the panel show a
    // checkmark for work the Gateway did not do, which is the failure this whole
    // area keeps producing.
    switch (outcome.outcome) {
      case 'revoked':
        res.json(outcome)
        return
      case 'already-absent':
        res.status(409).json({ ...outcome, error: 'those grants were already gone' })
        return
      case 'blocked-wildcard':
        res.status(409).json({
          ...outcome,
          error: 'that grant is set for every Boo, not just this one, so it cannot be removed here',
        })
        return
      case 'no-such-agent':
        res.status(409).json({ ...outcome, error: 'this Boo has no policy to change' })
        return
      case 'not-verified':
        res.status(502).json({
          ...outcome,
          error: 'the Gateway accepted the change and still lists those grants',
        })
        return
    }
  } catch (err) {
    // The Gateway's own words, passed through. An operator retrying forever
    // against a permanent refusal is the cost of a generic message here.
    res.status(502).json({ state: 'failed', error: redactValue(String(err)) })
  }
}
