// Hard USD budget kill-switch — the DB authority. `recordSpend` is an atomic
// read-modify-write under BEGIN IMMEDIATE (the board's contention recipe): it
// reads the current spend, applies the delta, recomputes the status via the
// SHARED @clawboo/governance math, and persists — all while holding the write
// lock, so two concurrent cost events can never lose an update. The pure tier
// math (80% soft / 100% hard) lives in @clawboo/governance; this is its
// persistent mirror, the single place the board's budget rows are written.

import { randomUUID } from 'node:crypto'

import {
  budgetStatusAfter,
  MICRO_CENTS_PER_CENT,
  statusForSpend,
  type BudgetCrossing,
  type BudgetStatus,
} from '@clawboo/governance'
import { and, desc, eq, type SQL } from 'drizzle-orm'

import { immediateWrite, withWriteRetry } from '../board/contention'
import type { ClawbooDb } from '../db'
import { budgets, type DbBudget } from '../schema'

/** Budget scopes: per-agent lifetime, per-mission (a delegation tree's ROOT task),
 *  per-team; `tenant` is the dormant per-org seam. */
export type BudgetScope = 'agent' | 'mission' | 'team' | 'tenant'

/** A budget's enforcement posture. `cap` auto-pauses the run at 100% (the budget
 *  kill-switch); `warn` only tracks spend + emits warning events at the crossings
 *  (the track-and-warn default posture), and NEVER auto-pauses. */
export type BudgetMode = 'cap' | 'warn'

export interface RecordSpendResult {
  status: BudgetStatus
  spentUsdCents: number
  limitUsdCents: number
  crossed: BudgetCrossing
  mode: BudgetMode
}

export function getBudget(db: ClawbooDb, scope: BudgetScope, scopeId: string): DbBudget | null {
  return (
    (db
      .select()
      .from(budgets)
      .where(and(eq(budgets.scope, scope), eq(budgets.scopeId, scopeId)))
      .get() as DbBudget | undefined) ?? null
  )
}

/**
 * Apply a spend delta to a scope's budget atomically; return the resulting status
 * and which threshold (if any) THIS delta crossed (so the caller acts exactly once
 * per crossing — audit, abort). Returns null when the scope has no budget row
 * (uncapped — the common case). Once `paused` it stays paused on further spend;
 * only a human `resumeBudget` or a raised `setBudgetLimit` re-opens it.
 *
 * `deltaCents` MAY be fractional (a sub-cent cost event, e.g. $0.004 ⇒ 0.4¢):
 * spend is accumulated in micro-cents so repeated tiny amounts are NOT floored to
 * 0. `spentUsdCents` (the whole-cent display + status mirror) is
 * `floor(spentMicroCents / MICRO_CENTS_PER_CENT)`.
 */
export function recordSpend(
  db: ClawbooDb,
  scope: BudgetScope,
  scopeId: string,
  deltaCents: number,
): RecordSpendResult | null {
  const deltaMicro = Math.max(0, Math.round(deltaCents * MICRO_CENTS_PER_CENT))
  return immediateWrite(db, (tx) => {
    const before = tx
      .select()
      .from(budgets)
      .where(and(eq(budgets.scope, scope), eq(budgets.scopeId, scopeId)))
      .get() as DbBudget | undefined
    if (!before) return null
    const mode = (before.mode as BudgetMode) === 'warn' ? 'warn' : 'cap'
    const newMicro = (before.spentMicroCents ?? 0) + deltaMicro
    const newSpentCents = Math.floor(newMicro / MICRO_CENTS_PER_CENT)
    // Feed the pure tier math the WHOLE-cent increment so `crossed` is detected on
    // cent boundaries exactly (sub-cent micro carry is invisible to the tier math).
    const computed = budgetStatusAfter({
      limitCents: before.limitUsdCents,
      spentCents: before.spentUsdCents,
      deltaCents: newSpentCents - before.spentUsdCents,
    })
    const { crossed } = computed
    let status = computed.status
    // Track-and-warn: a warn-mode budget records spend + reports its crossings, but
    // its persisted status never reads 'paused', so the executor kill-switch (which
    // triggers on status==='paused') leaves the run alone. `crossed` is derived from
    // the spend transition, so the 80% / 100% warnings still fire exactly once each.
    if (mode === 'warn' && status === 'paused') status = 'soft_capped'
    tx.update(budgets)
      .set({
        spentUsdCents: newSpentCents,
        spentMicroCents: newMicro,
        status,
        updatedAt: Date.now(),
      })
      .where(eq(budgets.id, before.id))
      .run()
    return {
      status,
      spentUsdCents: newSpentCents,
      limitUsdCents: before.limitUsdCents,
      crossed,
      mode,
    }
  })
}

export interface SetBudgetLimitInput {
  scope: BudgetScope
  scopeId: string
  limitUsdCents: number
  /** 'cap' (auto-pause at 100%) or 'warn' (track-and-warn, never pause). Default
   *  'warn' — the locked product posture (track-and-warn). A hard cap is opt-in. */
  mode?: BudgetMode
  tenantId?: string | null
}

/** Upsert a budget cap. A new scope starts at spent 0 / active. Re-setting the
 *  limit recomputes status from the EXISTING spend — so raising the cap above the
 *  current spend un-pauses the scope (the "raise the cap to resume" path). */
export function setBudgetLimit(db: ClawbooDb, input: SetBudgetLimitInput): DbBudget {
  const now = Date.now()
  const limitUsdCents = Math.max(0, Math.round(input.limitUsdCents))
  // Track-and-warn is the locked default posture; a hard 'cap' is opt-in.
  const mode: BudgetMode = input.mode === 'cap' ? 'cap' : 'warn'
  const existing = getBudget(db, input.scope, input.scopeId)
  if (!existing) {
    const row: DbBudget = {
      id: randomUUID(),
      scope: input.scope,
      scopeId: input.scopeId,
      limitUsdCents,
      spentUsdCents: 0,
      spentMicroCents: 0,
      status: 'active',
      mode,
      tenantId: input.tenantId ?? null,
      createdAt: now,
      updatedAt: now,
    }
    withWriteRetry(() => db.insert(budgets).values(row).run())
    return row
  }
  // Recompute from the EXISTING spend; a warn-mode budget never reads 'paused'.
  let status = statusForSpend(limitUsdCents, existing.spentUsdCents)
  if (mode === 'warn' && status === 'paused') status = 'soft_capped'
  withWriteRetry(() =>
    db
      .update(budgets)
      .set({ limitUsdCents, mode, status, updatedAt: now })
      .where(eq(budgets.id, existing.id))
      .run(),
  )
  return { ...existing, limitUsdCents, mode, status, updatedAt: now }
}

export interface ResumeBudgetOptions {
  /** Headroom (cents) to grant when the scope is still AT/OVER its limit: the
   *  limit is raised to `spent + graceUsdCents` so the resume actually makes
   *  forward progress instead of re-pausing on the very next cost event. */
  graceUsdCents?: number
}

/** Human override: force a paused scope back to active (the kill-switch re-arms on
 *  the next crossing). Returns null for an unknown scope. A bare resume of a scope
 *  whose spend already MEETS/EXCEEDS its limit re-pauses on the next cost event —
 *  pass `graceUsdCents` to raise the cap above current spend so progress can be
 *  made (the route surfaces a `willRepause` warning when no grace is given). */
export function resumeBudget(
  db: ClawbooDb,
  scope: BudgetScope,
  scopeId: string,
  opts: ResumeBudgetOptions = {},
): DbBudget | null {
  const existing = getBudget(db, scope, scopeId)
  if (!existing) return null
  const grace = opts.graceUsdCents
  if (grace != null && grace > 0 && existing.spentUsdCents >= existing.limitUsdCents) {
    // Raise the cap above current spend → setBudgetLimit recomputes status to
    // active with real headroom (the "raise the cap to resume" path).
    return setBudgetLimit(db, {
      scope,
      scopeId,
      limitUsdCents: existing.spentUsdCents + Math.round(grace),
      mode: (existing.mode as BudgetMode) === 'warn' ? 'warn' : 'cap',
      tenantId: existing.tenantId ?? null,
    })
  }
  const now = Date.now()
  withWriteRetry(() =>
    db
      .update(budgets)
      .set({ status: 'active', updatedAt: now })
      .where(eq(budgets.id, existing.id))
      .run(),
  )
  return { ...existing, status: 'active', updatedAt: now }
}

export function listBudgets(
  db: ClawbooDb,
  filter: { scope?: BudgetScope; status?: BudgetStatus } = {},
): DbBudget[] {
  const conds: SQL[] = []
  if (filter.scope) conds.push(eq(budgets.scope, filter.scope))
  if (filter.status) conds.push(eq(budgets.status, filter.status))
  return db
    .select()
    .from(budgets)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(budgets.updatedAt))
    .all() as DbBudget[]
}
