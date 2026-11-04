// Budget reservations: what a run that is going expects to spend, set aside on
// every budget it counts toward from the moment it is let start until it ends.
//
// Why: the run cap lets several runs start at once, and each one used to check
// the spent total alone, so runs started together against a nearly spent hard
// cap all passed and overshot it together. A run now takes a HOLD before it
// starts: one row per budget it counts toward, sized to its estimate. Every
// other run's admission reads those rows, the run's real spend shrinks its row
// as it is recorded (`recordSpend` with the hold's id), and the hold is deleted
// when the run ends, however it ends. What a budget has committed is then its
// spend plus what the runs going still hold.
//
// The admission rule, for a hard cap (`mode: 'cap'`):
//   - a paused cap refuses the run ('paused');
//   - a run with no other run going against the budget may start, as before: a
//     single run is still stopped by the kill-switch when its spend crosses the
//     cap;
//   - a run that would go IN PARALLEL with others starts only if the spend, plus
//     what the others still hold, plus its own estimate fits under the limit;
//     otherwise it is refused ('held').
// A warn-only budget never refuses; it still records holds, so switching it to
// a hard cap while runs are going sees them.
//
// Every write is one BEGIN IMMEDIATE transaction, so two admissions can never
// both read the same headroom.

import { randomUUID } from 'node:crypto'

import { MICRO_CENTS_PER_CENT } from '@clawboo/governance'
import { and, eq, inArray, ne, sql } from 'drizzle-orm'

import { immediateWrite, withWriteRetry, type BoardTx } from '../board/contention'
import type { ClawbooDb } from '../db'
import { budgetReservations, budgets, type DbBudget } from '../schema'
import type { BudgetMode, BudgetScope } from './budgets'

/** One budget a run counts toward. */
export interface BudgetHoldScope {
  scope: BudgetScope
  scopeId: string
}

/** The server process that holds a reservation, so a later boot can tell a
 *  live server's holds from a dead one's. */
export interface ReservationOwner {
  pid: number
  startedAt: number
}

/** Why a run was not let start: its cap is paused, or the room left under it is
 *  set aside for runs already going. */
export type BudgetRefusalReason = 'paused' | 'held'

export interface ReserveBudgetsInput {
  /** The run's hold. Reserving again with the same id is the final gate: rows
   *  the hold already has are kept, the rule is applied without them, and only
   *  budgets created since are added. Omitted: a new id. */
  holdId?: string
  /** Every budget the run counts toward. A scope with no budget row is uncapped
   *  and takes no hold. */
  scopes: readonly BudgetHoldScope[]
  /** The run's estimated cost in cents; may be fractional. */
  estimateCents: number
  /** What kind of run holds it ('task', 'team-chat', 'chat', 'routine', 'exchange'). */
  runKind: string
  /** The run's own id where it has one (an execution row, a session key). */
  runRef?: string | null
  owner?: ReservationOwner | null
  now?: number
}

export type ReserveBudgetsResult =
  { ok: true; holdId: string } | { ok: false; scope: BudgetScope; reason: BudgetRefusalReason }

/** Still held on one budget by runs other than `holdId`: their rows and their sum. */
function othersOn(
  tx: BoardTx,
  budgetId: string,
  holdId: string,
): { runs: number; heldMicro: number } {
  const row = tx
    .select({
      runs: sql<number>`count(*)`,
      heldMicro: sql<number>`coalesce(sum(${budgetReservations.heldMicroCents}), 0)`,
    })
    .from(budgetReservations)
    .where(and(eq(budgetReservations.budgetId, budgetId), ne(budgetReservations.holdId, holdId)))
    .get() as { runs: number; heldMicro: number } | undefined
  return { runs: Number(row?.runs ?? 0), heldMicro: Number(row?.heldMicro ?? 0) }
}

/**
 * Whether a run may start against one budget, given what the runs already going
 * hold on it. Pure: the rule in the header, for one budget row.
 */
export function admitAgainstBudget(input: {
  mode: BudgetMode
  status: string
  limitMicroCents: number
  spentMicroCents: number
  /** How many OTHER runs hold this budget, and how much they still hold. */
  otherRuns: number
  otherHeldMicroCents: number
  estimateMicroCents: number
}): BudgetRefusalReason | null {
  if (input.mode !== 'cap') return null
  if (input.status === 'paused') return 'paused'
  if (input.otherRuns === 0) return null
  const committed = input.spentMicroCents + input.otherHeldMicroCents + input.estimateMicroCents
  return committed > input.limitMicroCents ? 'held' : null
}

/**
 * Hold `estimateCents` on every budget the run counts toward, or refuse with the
 * first budget (in the order given) that will not let it start. A refusal writes
 * nothing. The checks and the inserts share one BEGIN IMMEDIATE transaction.
 */
export function reserveBudgets(db: ClawbooDb, input: ReserveBudgetsInput): ReserveBudgetsResult {
  const holdId = input.holdId ?? randomUUID()
  const estimateMicro = Math.max(0, Math.round(input.estimateCents * MICRO_CENTS_PER_CENT))
  const now = input.now ?? Date.now()
  return immediateWrite(db, (tx): ReserveBudgetsResult => {
    const rows: DbBudget[] = []
    for (const s of input.scopes) {
      const b = tx
        .select()
        .from(budgets)
        .where(and(eq(budgets.scope, s.scope), eq(budgets.scopeId, s.scopeId)))
        .get() as DbBudget | undefined
      if (!b) continue
      const others = othersOn(tx, b.id, holdId)
      const refused = admitAgainstBudget({
        mode: (b.mode as BudgetMode) === 'cap' ? 'cap' : 'warn',
        status: b.status,
        limitMicroCents: b.limitUsdCents * MICRO_CENTS_PER_CENT,
        spentMicroCents: b.spentMicroCents ?? 0,
        otherRuns: others.runs,
        otherHeldMicroCents: others.heldMicro,
        estimateMicroCents: estimateMicro,
      })
      if (refused) return { ok: false, scope: s.scope, reason: refused }
      rows.push(b)
    }
    for (const b of rows) {
      tx.insert(budgetReservations)
        .values({
          id: randomUUID(),
          holdId,
          budgetId: b.id,
          heldMicroCents: estimateMicro,
          estimateMicroCents: estimateMicro,
          runKind: input.runKind,
          runRef: input.runRef ?? null,
          ownerPid: input.owner?.pid ?? null,
          ownerStartedAt: input.owner?.startedAt ?? null,
          createdAt: now,
          updatedAt: now,
        })
        .onConflictDoNothing()
        .run()
    }
    return { ok: true, holdId }
  })
}

/** Delete a run's hold on every budget: the run is over. Returns the rows removed. */
export function releaseBudgetHold(db: ClawbooDb, holdId: string): number {
  return withWriteRetry(
    () => db.delete(budgetReservations).where(eq(budgetReservations.holdId, holdId)).run().changes,
  )
}

/** What the runs going still hold on each budget, by budget id. */
export function heldByBudget(db: ClawbooDb): Map<string, { runs: number; heldMicroCents: number }> {
  const rows = db
    .select({
      budgetId: budgetReservations.budgetId,
      runs: sql<number>`count(*)`,
      heldMicro: sql<number>`coalesce(sum(${budgetReservations.heldMicroCents}), 0)`,
    })
    .from(budgetReservations)
    .groupBy(budgetReservations.budgetId)
    .all() as { budgetId: string; runs: number; heldMicro: number }[]
  return new Map(
    rows.map((r) => [r.budgetId, { runs: Number(r.runs), heldMicroCents: Number(r.heldMicro) }]),
  )
}

/** Every server process that holds a reservation; `null` stands for rows that name none. */
export function budgetReservationOwners(db: ClawbooDb): (ReservationOwner | null)[] {
  const rows = db
    .selectDistinct({
      pid: budgetReservations.ownerPid,
      startedAt: budgetReservations.ownerStartedAt,
    })
    .from(budgetReservations)
    .all() as { pid: number | null; startedAt: number | null }[]
  return rows.map((r) =>
    r.pid != null && r.startedAt != null ? { pid: r.pid, startedAt: r.startedAt } : null,
  )
}

/**
 * Drop the holds no live run can still settle: every row whose owner is not in
 * `liveOwners` (rows that name no owner included), and every row created before
 * `createdBefore`. Called at boot, when this server holds none yet. Returns the
 * rows removed.
 */
export function sweepBudgetReservations(
  db: ClawbooDb,
  opts: { liveOwners: readonly ReservationOwner[]; createdBefore: number },
): number {
  return immediateWrite(db, (tx) => {
    const rows = tx
      .select({
        id: budgetReservations.id,
        pid: budgetReservations.ownerPid,
        startedAt: budgetReservations.ownerStartedAt,
        createdAt: budgetReservations.createdAt,
      })
      .from(budgetReservations)
      .all() as { id: string; pid: number | null; startedAt: number | null; createdAt: number }[]
    const live = (pid: number | null, startedAt: number | null): boolean =>
      opts.liveOwners.some((o) => o.pid === pid && o.startedAt === startedAt)
    const drop = rows
      .filter((r) => r.createdAt < opts.createdBefore || !live(r.pid, r.startedAt))
      .map((r) => r.id)
    if (drop.length === 0) return 0
    return tx.delete(budgetReservations).where(inArray(budgetReservations.id, drop)).run().changes
  })
}
