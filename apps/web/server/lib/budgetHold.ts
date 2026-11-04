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
// restart of the whole server is the boot sweep's (`sweepBudgetHoldsAtBoot`).
//
// A hold changes nothing for a run going alone, and nothing for a warn-only
// budget: what it stops is several runs starting together against a nearly spent
// hard cap and overshooting it together.
//
// A ledger read or write that fails lets the run go without a hold, as a failed
// spend write always has: the budget is a guardrail, never a reason for silence.

import {
  budgetReservationOwners,
  costRecords,
  releaseBudgetHold,
  reserveBudgets,
  sweepBudgetReservations,
  type BudgetHoldScope,
  type BudgetRefusalReason,
  type BudgetScope,
  type ClawbooDb,
  type ReservationOwner,
} from '@clawboo/db'
import { usdToFractionalCents } from '@clawboo/governance'
import { createLogger } from '@clawboo/logger'
import { desc, eq } from 'drizzle-orm'

import type { BudgetPreflightScopes } from './budgetPreflight'
import { DEFAULTS } from './defaults'
import {
  isAlive,
  MAX_TRUSTED_AGE_MS,
  processStartTimes,
  START_TIME_SLACK_MS,
  type StartTimes,
} from './processIdentity'

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

/**
 * What to hold for one run of this agent, in cents: the most any of its last
 * runs cost (`DEFAULTS.budgetReserveHistoryRuns` of them, from the same records
 * Tokens Used reads), or `DEFAULTS.budgetReserveDefaultUsdCents` for an agent
 * with none. An estimate: a run can cost more or less than any run before it.
 */
export function estimateRunReserveCents(db: ClawbooDb, agentId: string | null | undefined): number {
  if (!agentId) return DEFAULTS.budgetReserveDefaultUsdCents
  try {
    const rows = db
      .select({ costUsd: costRecords.costUsd })
      .from(costRecords)
      .where(eq(costRecords.agentId, agentId))
      .orderBy(desc(costRecords.createdAt), desc(costRecords.id))
      .limit(DEFAULTS.budgetReserveHistoryRuns)
      .all() as { costUsd: number }[]
    if (rows.length === 0) return DEFAULTS.budgetReserveDefaultUsdCents
    return usdToFractionalCents(Math.max(0, ...rows.map((r) => r.costUsd || 0)))
  } catch {
    return DEFAULTS.budgetReserveDefaultUsdCents
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
    return { blocked: false, hold: NO_BUDGET_HOLD }
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
          return { blocked: false }
        }
      },
      release(): void {
        if (released) return
        released = true
        try {
          releaseBudgetHold(db, holdId)
        } catch (err) {
          // Left for the boot sweep.
          log.error({ err, kind: run.kind, ref: run.ref }, 'budget hold could not be released')
        }
      },
    },
  }
}

export interface BudgetHoldSweepDeps {
  isAlive?: (pid: number) => boolean
  startTimes?: (pids: readonly number[]) => StartTimes
  now?: number
}

/**
 * Drop the holds no run can settle any more: those of a server that is no longer
 * running (its pid is free, or now names a process that started at another
 * time), those that name no server, and any older than `MAX_TRUSTED_AGE_MS`.
 * Called once at boot, before this server starts a run.
 *
 * Errs towards DROPPING when it cannot tell, the reverse of the runtime reap:
 * a wrongly kept hold blocks parallel runs on its budget for good, while a
 * wrongly dropped one only lets a parallel run start beside a run still going.
 * A second server still running on the same state directory keeps its holds.
 */
export function sweepBudgetHoldsAtBoot(db: ClawbooDb, deps: BudgetHoldSweepDeps = {}): number {
  const alive = deps.isAlive ?? isAlive
  const startTimes = deps.startTimes ?? processStartTimes
  const now = deps.now ?? Date.now()
  const others = budgetReservationOwners(db).filter(
    (o): o is ReservationOwner =>
      o !== null && !(o.pid === ENGINE.pid && o.startedAt === ENGINE.startedAt),
  )
  const running = others.filter((o) => o.pid !== process.pid && alive(o.pid))
  const probe = running.length > 0 ? startTimes(running.map((o) => o.pid)) : null
  const live = running.filter((o) => {
    const startedAt = probe?.ok ? probe.times.get(o.pid) : undefined
    return startedAt !== undefined && Math.abs(startedAt - o.startedAt) <= START_TIME_SLACK_MS
  })
  return sweepBudgetReservations(db, {
    liveOwners: [ENGINE, ...live],
    createdBefore: now - MAX_TRUSTED_AGE_MS,
  })
}
