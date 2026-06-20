// Pre-flight budget gate: refuse to START a run when a relevant CAP budget is
// already paused. The mid-run kill-switch stops an in-flight run; this stops the
// NEXT one — the only enforceable cap for a connected substrate that reports no
// incremental cost (its spend lands only on the terminal). A warn-mode budget is
// clamped to never read 'paused', so it never blocks here.

import { getBudget, type BudgetScope, type ClawbooDb } from '@clawboo/db'

export interface BudgetPreflightScopes {
  agentId?: string | null
  missionId?: string | null
  teamId?: string | null
}

export type BudgetPreflightResult = { blocked: false } | { blocked: true; scope: BudgetScope }

/**
 * Returns the first cap-paused scope (checked most-specific first: agent →
 * mission → team), or `{ blocked: false }`. A scope with no budget row is
 * uncapped (skipped). Only a `cap`-mode `paused` budget blocks.
 */
export function budgetPreflight(
  db: ClawbooDb,
  scopes: BudgetPreflightScopes,
): BudgetPreflightResult {
  const checks: [BudgetScope, string | null | undefined][] = [
    ['agent', scopes.agentId],
    ['mission', scopes.missionId],
    ['team', scopes.teamId],
  ]
  for (const [scope, scopeId] of checks) {
    if (!scopeId) continue
    const b = getBudget(db, scope, scopeId)
    if (b && b.status === 'paused' && b.mode === 'cap') return { blocked: true, scope }
  }
  return { blocked: false }
}
