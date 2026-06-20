// ─── Governance budgets REST ───────────────────────────
// The human-facing surface for the hard USD budget kill-switch: list caps, set/
// raise a cap, and resume a paused scope (human override). The atomic spend
// increment itself happens in the executor loop.

import type { Request, Response } from 'express'

import {
  createDb,
  listBudgets,
  resumeBudget,
  resumeBudgetBody,
  setBudgetBody,
  setBudgetLimit,
} from '@clawboo/db'

import { getDbPath } from '../lib/db'

const SCOPES = ['agent', 'mission', 'team', 'tenant'] as const
type ScopeName = (typeof SCOPES)[number]
const isScope = (v: unknown): v is ScopeName =>
  typeof v === 'string' && (SCOPES as readonly string[]).includes(v)

// GET /api/governance/budgets
export function budgetsListGET(_req: Request, res: Response): void {
  res.json({ budgets: listBudgets(createDb(getDbPath())) })
}

// POST /api/governance/budgets — { scope, scopeId, limitUsdCents, tenantId? } (set/raise a cap)
export function budgetsSetPOST(req: Request, res: Response): void {
  const parsed = setBudgetBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
    return
  }
  res.json({ budget: setBudgetLimit(createDb(getDbPath()), parsed.data) })
}

// POST /api/governance/budgets/:scope/:scopeId/resume — human override / un-pause.
// Body (optional): { graceUsdCents } to raise the cap above current spend so the
// resume makes forward progress. Returns `willRepause: true` when the scope is
// resumed while still at/over its limit (no grace) — the UI warns the operator.
export function budgetsResumePOST(req: Request, res: Response): void {
  const scope = req.params['scope']
  const scopeId = typeof req.params['scopeId'] === 'string' ? req.params['scopeId'] : ''
  if (!isScope(scope)) {
    res.status(400).json({ error: 'invalid scope' })
    return
  }
  const parsed = resumeBudgetBody.safeParse(req.body ?? {})
  if (!parsed.success) {
    res.status(400).json({ error: 'invalid body', details: parsed.error.flatten() })
    return
  }
  const budget = resumeBudget(createDb(getDbPath()), scope, scopeId, parsed.data)
  if (!budget) {
    res.status(404).json({ error: 'budget not found' })
    return
  }
  const willRepause = budget.spentUsdCents >= budget.limitUsdCents
  res.json({ budget, willRepause })
}
