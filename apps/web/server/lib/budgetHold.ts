// Budget holds for runs: the server side of the reservations in @clawboo/db
// (governance/reservations.ts).
//
// Every run start (a board task, a routine, a team-chat delivery, a one-to-one
// chat turn, a peer-exchange turn) takes a hold on the budgets it counts toward
// once it has its run slot and its agent's lock, at the point where it used to
// check only for a paused cap. The hold is the run's estimated cost. The run
// checks it again at the final gate, right before the model call, passes the
// hold's id with every spend it records (so its real spend replaces the
// estimate as it lands), and releases the hold when it ends, however it ends:
// a reply, a failure, a Stop, a watchdog, a crash of its own code. A crash or a
// restart of the whole server is the start-up sweep's (`sweepLeftoverBudgetHolds`).
//
// A hold changes nothing for a run going alone, and nothing for a warn-only
// budget: what it stops is several runs starting together against a nearly spent
// hard cap and overshooting it together.
//
// A ledger write that fails lets the run go without a hold, as a failed spend
// write always has: the budget is a guardrail, never a reason for silence. A
// paused hard cap still refuses it whenever the budgets can be read at all.

import {
  releaseBudgetHold,
  reserveBudgets,
  sweepForeignBudgetReservations,
  type BudgetHoldScope,
  type BudgetRefusalReason,
  type BudgetScope,
  type ClawbooDb,
  type ReservationOwner,
} from '@clawboo/db'
import { usdToFractionalCents } from '@clawboo/governance'
import { createLogger } from '@clawboo/logger'
import { sql } from 'drizzle-orm'

import { budgetPreflight, type BudgetPreflightScopes } from './budgetPreflight'
import { DEFAULTS } from './defaults'

const log = createLogger('budget-hold')

/** This server process, as its holds name it. */
const ENGINE: ReservationOwner = {
  pid: process.pid,
  startedAt: Math.round(Date.now() - process.uptime() * 1000),
}

export type BudgetGateResult =
  { blocked: false } | { blocked: true; scope: BudgetScope; reason: BudgetRefusalReason }

/** A run's hold on its budgets. */
export interface RunBudgetHold {
  /** Pass with every spend the run records (`recordSpend(..., { holdId })`).
   *  Null when the run holds nothing (the ledger could not be read). */
  readonly id: string | null
  /** The final gate, right before the model call: the same rule as at the start,
   *  without this run's own hold. */
  recheck(): BudgetGateResult
  /** The run is over. Safe to call any number of times. */
  release(): void
}

export type RunBudgetGate =
  | { blocked: false; hold: RunBudgetHold }
  | { blocked: true; scope: BudgetScope; reason: BudgetRefusalReason }

export interface RunBudgetRequest {
  /** 'task', 'routine', 'team-chat', 'chat' or 'exchange'. */
  kind: string
  /** The run's own id where it has one (its task, its session key). */
  ref?: string | null
  /** The estimate to hold, in cents. Omitted: `estimateRunReserveCents` for the agent. */
  estimateCents?: number
}

/** The order a refusal names a scope in: most specific first, as the pre-flight gate. */
function holdScopes(scopes: BudgetPreflightScopes): BudgetHoldScope[] {
  const out: BudgetHoldScope[] = []
  if (scopes.agentId) out.push({ scope: 'agent', scopeId: scopes.agentId })
  if (scopes.missionId) out.push({ scope: 'mission', scopeId: scopes.missionId })
  if (scopes.teamId) out.push({ scope: 'team', scopeId: scopes.teamId })
  return out
}

/** How many of an agent's latest cost records are read to find its latest runs:
 *  enough for ten runs of many turns each, bounded so the read stays small. */
const RESERVE_HISTORY_ROWS = 1_000

/**
 * What to hold for one run of this agent, in cents: the most any of its last
 * runs cost (`DEFAULTS.budgetReserveHistoryRuns` of them, from the same records
 * Tokens Used reads), or `DEFAULTS.budgetReserveDefaultUsdCents` for an agent
 * with none. A run is its records that share a run id, summed: an OpenClaw run
 * is recorded turn by turn. A record with no run id is a run of its own. An
 * estimate: a run can cost more or less than any run before it.
 */
export function estimateRunReserveCents(db: ClawbooDb, agentId: string | null | undefined): number {
  if (!agentId) return DEFAULTS.budgetReserveDefaultUsdCents
  try {
    const runs = db.all(sql`
      SELECT sum(cost_usd) AS total, max(created_at) AS last
      FROM (
        SELECT id, run_id, cost_usd, created_at FROM cost_records
        WHERE agent_id = ${agentId}
        ORDER BY created_at DESC, id DESC
        LIMIT ${RESERVE_HISTORY_ROWS}
      )
      GROUP BY coalesce('run:' || run_id, 'row:' || id)
      ORDER BY last DESC
      LIMIT ${DEFAULTS.budgetReserveHistoryRuns}
    `) as { total: number | null }[]
    if (runs.length === 0) return DEFAULTS.budgetReserveDefaultUsdCents
    return usdToFractionalCents(Math.max(0, ...runs.map((r) => r.total || 0)))
  } catch {
    return DEFAULTS.budgetReserveDefaultUsdCents
  }
}

/** The paused-cap check alone, for when the hold itself could not be read or
 *  written: a paused hard cap still refuses the run. A read that fails too lets
 *  it go. */
function pausedOnly(db: ClawbooDb, scopes: BudgetPreflightScopes, run: RunBudgetRequest) {
  try {
    const pre = budgetPreflight(db, scopes)
    return pre.blocked
      ? { blocked: true as const, scope: pre.scope, reason: 'paused' as const }
      : null
  } catch (err) {
    log.error({ err, kind: run.kind, ref: run.ref }, 'budgets could not be read')
    return null
  }
}

/** Holds whose delete failed, retried on the next admission against the same
 *  database (and at the next start), so a failed delete does not count against
 *  a cap for the rest of the server's life. */
const pendingReleases = new Map<string, ClawbooDb>()

function retryPendingReleases(db: ClawbooDb): void {
  for (const [holdId, owner] of pendingReleases) {
    if (owner !== db) continue
    try {
      releaseBudgetHold(db, holdId)
      pendingReleases.delete(holdId)
    } catch {
      // Still failing: kept for the next admission.
    }
  }
}

/** The hold of a run that holds nothing: no budget applies, or the ledger could
 *  not be read. */
export const NO_BUDGET_HOLD: RunBudgetHold = {
  id: null,
  recheck: () => ({ blocked: false }),
  release: () => undefined,
}

/**
 * Let a run start against its budgets and hold its estimate on each, or say which
 * budget refuses it and why. Call it once the run has its slot and its agent's
 * lock, before anything is claimed or spent.
 */
export function reserveRunBudget(
  db: ClawbooDb,
  scopes: BudgetPreflightScopes,
  run: RunBudgetRequest,
): RunBudgetGate {
  const list = holdScopes(scopes)
  if (list.length === 0) return { blocked: false, hold: NO_BUDGET_HOLD }
  retryPendingReleases(db)
  const estimateCents = run.estimateCents ?? estimateRunReserveCents(db, scopes.agentId)
  const input = {
    scopes: list,
    estimateCents,
    runKind: run.kind,
    runRef: run.ref ?? null,
    owner: ENGINE,
  }
  let first
  try {
    first = reserveBudgets(db, input)
  } catch (err) {
    log.error({ err, kind: run.kind, ref: run.ref }, 'budget hold could not be taken')
    return pausedOnly(db, scopes, run) ?? { blocked: false, hold: NO_BUDGET_HOLD }
  }
  if (!first.ok) return { blocked: true, scope: first.scope, reason: first.reason }
  const holdId = first.holdId
  let released = false
  return {
    blocked: false,
    hold: {
      id: holdId,
      recheck(): BudgetGateResult {
        if (released) return { blocked: false }
        try {
          const again = reserveBudgets(db, { ...input, holdId })
          return again.ok ? { blocked: false } : { blocked: true, ...again }
        } catch (err) {
          log.error({ err, kind: run.kind, ref: run.ref }, 'budget hold could not be checked')
          return pausedOnly(db, scopes, run) ?? { blocked: false }
        }
      },
      release(): void {
        if (released) return
        released = true
        try {
          releaseBudgetHold(db, holdId)
        } catch (err) {
          // Retried at the next admission (see `pendingReleases`).
          pendingReleases.set(holdId, db)
          log.error({ err, kind: run.kind, ref: run.ref }, 'budget hold could not be released')
        }
      },
    },
  }
}

/** How often a start-up sweep that failed is tried again, and how many times. */
export const HOLD_SWEEP_RETRY_MS = 30_000
export const HOLD_SWEEP_MAX_TRIES = 10

export interface BudgetHoldSweepOptions {
  retryMs?: number
  maxTries?: number
  /** Test seam: the sweep itself (default: drop every hold this server did not take). */
  sweep?: () => number
  /** Test seam for the timer. */
  schedule?: (fn: () => void, ms: number) => void
}

/**
 * Drop the holds left by a server that stopped while its runs were going (a
 * crash, a force quit, a restart mid-run): every hold this process did not take.
 * Clawboo runs one server per database (the `clawboo` command never starts a
 * second, and an in-app restart starts the new server once the old one has let
 * go of its port), so no other process should still settle them. If one briefly
 * does (an old server still winding down), losing its holds only lets a parallel
 * run start beside it; keeping a dead server's holds would refuse parallel runs
 * on those budgets for good. Called at start, before this server starts a
 * run. A sweep that fails (the database busy past its retry budget) is tried
 * again every `retryMs`, up to `maxTries` in all; it never touches this
 * server's own holds, so a later pass is as safe as the first.
 */
export function sweepLeftoverBudgetHolds(db: ClawbooDb, opts: BudgetHoldSweepOptions = {}): void {
  const sweep = opts.sweep ?? (() => sweepForeignBudgetReservations(db, ENGINE))
  const retryMs = opts.retryMs ?? HOLD_SWEEP_RETRY_MS
  const maxTries = opts.maxTries ?? HOLD_SWEEP_MAX_TRIES
  const schedule =
    opts.schedule ??
    ((fn: () => void, ms: number): void => {
      setTimeout(fn, ms).unref?.()
    })
  const attempt = (tries: number): void => {
    try {
      const swept = sweep()
      if (swept > 0) log.info({ swept }, 'dropped budget holds left by runs that are gone')
    } catch (err) {
      const again = tries < maxTries
      log.error({ err, tries, again }, 'sweeping leftover budget holds failed')
      if (again) schedule(() => attempt(tries + 1), retryMs)
    }
  }
  attempt(1)
}
