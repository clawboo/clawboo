// The audit rows for spend the task runner does not charge: team chat, 1:1 chat,
// the peer exchange, and an OpenClaw routine's cost events. Each writes the row when
// a charge crosses 80% or 100% of a budget, which `recordSpend` reports exactly once
// per crossing, so the audit log can say when a budget was reached however the money
// was spent.
//
// A row the task runner writes has the same shape, with `reason: 'warn'`. Those
// paths have no later step that records a hard cap pausing, so here the crossing
// itself says so, as `reason: 'auto_pause'`.
//
// Best-effort, like the charge it describes: an audit write that fails must never
// end the run or swallow its reply.

import {
  appendAudit,
  type BudgetScope,
  type ClawbooDb,
  type DbBudget,
  type RecordSpendResult,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'

import { DEFAULTS } from './defaults'

const log = createLogger('budget-audit')

export interface BudgetCrossingInput {
  scope: BudgetScope
  scopeId: string
  /** What `recordSpend` answered. Null: the scope has no budget. */
  result: RecordSpendResult | null
  /** Which kind of run spent it, as its budget hold names it. */
  runKind: 'team-chat' | 'chat' | 'exchange' | 'routine'
  agentId: string
  teamId?: string | null
  taskId?: string | null
  tenantId?: string | null
  /** More for the row, on a path that records more than the crossing. */
  extra?: Record<string, unknown>
}

export function auditBudgetCrossing(db: ClawbooDb, input: BudgetCrossingInput): void {
  const { result: r, scope, scopeId, runKind, agentId, teamId, taskId, tenantId, extra } = input
  if (!r || r.crossed === 'none') return
  try {
    appendAudit(db, {
      eventType: 'budget',
      agentId,
      teamId: teamId ?? null,
      taskId: taskId ?? null,
      tenantId: tenantId ?? null,
      summary: {
        ...extra,
        reason: r.crossed === 'hard' && r.mode === 'cap' ? 'auto_pause' : 'warn',
        level: r.crossed,
        mode: r.mode,
        scope,
        scopeId,
        pct: r.crossed === 'hard' ? 100 : DEFAULTS.budgetWarnSoftPct,
        spentUsdCents: r.spentUsdCents,
        limitUsdCents: r.limitUsdCents,
        runKind,
      },
    })
  } catch (err) {
    log.error({ err, scope, scopeId }, 'budget crossing audit failed')
  }
}

/** The part of a budget an edit can change, as an audit row records it. */
const budgetTerms = (b: DbBudget) => ({
  limitUsdCents: b.limitUsdCents,
  mode: b.mode,
  status: b.status,
})

export interface BudgetEditInput {
  action: 'set_limit' | 'resume'
  after: DbBudget
  /** Null for a new budget. */
  before: DbBudget | null
  /** Who asked: the route's `actorField`, or how a budget came to be set otherwise. */
  by: Record<string, unknown>
}

/**
 * Put a budget edit on record: what changed and who asked. A cap is what stands
 * between a run and the money, so each change leaves a row in the audit log. A
 * failed write never fails the edit, which has already happened.
 */
export function auditBudgetEdit(db: ClawbooDb, input: BudgetEditInput): void {
  const { action, after, before, by } = input
  try {
    appendAudit(db, {
      eventType: 'budget',
      teamId: after.scope === 'team' ? after.scopeId : null,
      agentId: after.scope === 'agent' ? after.scopeId : null,
      tenantId: after.tenantId,
      summary: {
        reason: 'edit',
        action,
        scope: after.scope,
        scopeId: after.scopeId,
        spentUsdCents: after.spentUsdCents,
        before: before ? budgetTerms(before) : null,
        after: budgetTerms(after),
        ...by,
      },
    })
  } catch (err) {
    log.error({ err, scope: after.scope, scopeId: after.scopeId }, 'budget edit audit failed')
  }
}
