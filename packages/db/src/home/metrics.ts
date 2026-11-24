// What Home works out from Clawboo's own data, on read: the computed KPIs, the
// numbers behind a team's status line, its spend, and what waits on a person.
//
// One snapshot per team per read (`teamSnapshot`), so a Home with many KPIs reads
// the board once. Periods are rolling: the last 7, 30 or 90 days.

import type { TaskAttention } from '@clawboo/board-core'
import { isVerdictPromotable, MICRO_CENTS_PER_CENT } from '@clawboo/governance'
import { and, eq, gte, inArray, isNotNull, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { attentionForTasks } from '../board/attention'
import { listTasks } from '../board/repository'
import { agents, budgets, costRecords, executionProcesses, tasks, type DbTask } from '../schema'
import {
  DAY_MS,
  HOME_POINT_IN_TIME_METRICS,
  KPI_PERIOD_MS,
  type HomeComputedMetric,
  type KpiPeriod,
} from './types'

/** True when a check passed, false when it failed, null with no check. */
export function checkOutcome(verification: string | null | undefined): boolean | null {
  if (!verification) return null
  try {
    return isVerdictPromotable(JSON.parse(verification))
  } catch {
    return null
  }
}

/** A team's board, read once for one Home answer. */
export interface TeamSnapshot {
  teamId: string
  now: number
  /** The team's tasks that are not removed. */
  tasks: DbTask[]
  /** Why each task needs a person, for the ones that do. */
  attention: Map<string, TaskAttention>
  /** Agents on the team now. */
  agentIds: string[]
}

export function teamSnapshot(db: ClawbooDb, teamId: string, now = Date.now()): TeamSnapshot {
  const rows = listTasks(db, { teamId })
  const attention = new Map<string, TaskAttention>()
  for (const [id, a] of attentionForTasks(db, rows)) if (a) attention.set(id, a)
  const agentIds = db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.teamId, teamId))
    .all()
    .map((a) => a.id)
  return { teamId, now, tasks: rows, attention, agentIds }
}

/** The start of a period, or null for all time. */
export function periodStart(period: KpiPeriod, now: number): number | null {
  const span = KPI_PERIOD_MS[period]
  return span === null ? null : now - span
}

const isOpen = (t: DbTask): boolean => t.status !== 'done' && t.status !== 'cancelled'
const doneSince = (t: DbTask, since: number | null): boolean =>
  t.status === 'done' && (since === null || (t.completedAt ?? t.updatedAt) >= since)

/** What the team's agents' runs cost since `since` (all time with null). */
export function teamSpendUsd(db: ClawbooDb, snap: TeamSnapshot, since: number | null): number {
  if (snap.agentIds.length === 0) return 0
  const where =
    since === null
      ? inArray(costRecords.agentId, snap.agentIds)
      : and(inArray(costRecords.agentId, snap.agentIds), gte(costRecords.createdAt, since))
  const row = db
    .select({ usd: sql<number>`coalesce(sum(${costRecords.costUsd}), 0)` })
    .from(costRecords)
    .where(where)
    .get()
  return Number(row?.usd ?? 0)
}

/** Whether any run of the team's tasks since `since` priced itself by an estimate. */
export function teamSpendIncludesEstimates(
  db: ClawbooDb,
  teamId: string,
  since: number | null,
): boolean {
  const conds = [
    eq(tasks.teamId, teamId),
    isNotNull(executionProcesses.costUsd),
    sql`coalesce(${executionProcesses.costSource}, '') NOT IN ('reported', 'local')`,
  ]
  if (since !== null) conds.push(gte(executionProcesses.createdAt, since))
  const row = db
    .select({ id: executionProcesses.id })
    .from(executionProcesses)
    .innerJoin(tasks, eq(tasks.id, executionProcesses.taskId))
    .where(and(...conds))
    .limit(1)
    .get()
  return row !== undefined
}

export interface TeamBudgetView {
  limitUsd: number
  spentUsd: number
  mode: string
  status: string
}

export function teamBudget(db: ClawbooDb, teamId: string): TeamBudgetView | null {
  const row = db
    .select()
    .from(budgets)
    .where(and(eq(budgets.scope, 'team'), eq(budgets.scopeId, teamId)))
    .get()
  if (!row) return null
  const spentMicro = row.spentMicroCents ?? row.spentUsdCents * MICRO_CENTS_PER_CENT
  return {
    limitUsd: row.limitUsdCents / 100,
    spentUsd: spentMicro / MICRO_CENTS_PER_CENT / 100,
    mode: row.mode,
    status: row.status,
  }
}

function median(values: number[]): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const mid = Math.floor(sorted.length / 2)
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
}

/** Finished runs of the team's tasks since `since` that succeeded, as a percent. */
function runSuccessRate(db: ClawbooDb, teamId: string, since: number | null): number | null {
  const conds = [
    eq(tasks.teamId, teamId),
    inArray(executionProcesses.status, ['succeeded', 'failed', 'timed_out']),
  ]
  if (since !== null) conds.push(gte(executionProcesses.completedAt, since))
  const row = db
    .select({
      finished: sql<number>`count(*)`,
      ok: sql<number>`sum(case when ${executionProcesses.status} = 'succeeded' then 1 else 0 end)`,
    })
    .from(executionProcesses)
    .innerJoin(tasks, eq(tasks.id, executionProcesses.taskId))
    .where(and(...conds))
    .get()
  const finished = Number(row?.finished ?? 0)
  if (finished === 0) return null
  return (Number(row?.ok ?? 0) / finished) * 100
}

/**
 * One computed metric for a team, over `period` (point-in-time metrics ignore it).
 * Null when there is nothing to measure: no runs for a success rate, no finished
 * task for a median, no budget for a budget share.
 */
export function computeMetric(
  db: ClawbooDb,
  snap: TeamSnapshot,
  metric: HomeComputedMetric,
  period: KpiPeriod,
): number | null {
  const since = HOME_POINT_IN_TIME_METRICS.includes(metric) ? null : periodStart(period, snap.now)
  const work = snap.tasks.filter((t) => t.isMainTask !== 1)
  switch (metric) {
    case 'tasks_done':
      return work.filter((t) => doneSince(t, since)).length
    case 'tasks_checked_done':
      return work.filter((t) => doneSince(t, since) && checkOutcome(t.verification) === true).length
    case 'requests_done':
      return snap.tasks.filter((t) => t.isMainTask === 1 && doneSince(t, since)).length
    case 'spend_usd':
      return teamSpendUsd(db, snap, since)
    case 'budget_used_pct': {
      const budget = teamBudget(db, snap.teamId)
      if (!budget || budget.limitUsd <= 0) return null
      return (budget.spentUsd / budget.limitUsd) * 100
    }
    case 'run_success_rate':
      return runSuccessRate(db, snap.teamId, since)
    case 'needs_you_count':
      return snap.attention.size
    case 'median_hours_to_done':
      return median(
        work
          .filter((t) => doneSince(t, since))
          .map((t) => ((t.completedAt ?? t.updatedAt) - t.createdAt) / (60 * 60 * 1000)),
      )
    case 'open_requests':
      return snap.tasks.filter((t) => t.isMainTask === 1 && isOpen(t)).length
  }
}

// ─── The status line ─────────────────────────────────────────────────────────

export interface StatusFacts {
  requestsInFlight: number
  needsYou: number
  doneLast7Days: number
  spentLast7DaysUsd: number
  budgetLimitUsd: number | null
  budgetSpentUsd: number | null
}

export function statusFacts(db: ClawbooDb, snap: TeamSnapshot): StatusFacts {
  const weekAgo = snap.now - 7 * DAY_MS
  const budget = teamBudget(db, snap.teamId)
  return {
    requestsInFlight: snap.tasks.filter((t) => t.isMainTask === 1 && isOpen(t)).length,
    needsYou: snap.attention.size,
    doneLast7Days: snap.tasks.filter((t) => t.isMainTask !== 1 && doneSince(t, weekAgo)).length,
    spentLast7DaysUsd: teamSpendUsd(db, snap, weekAgo),
    budgetLimitUsd: budget?.limitUsd ?? null,
    budgetSpentUsd: budget?.spentUsd ?? null,
  }
}

function usd(n: number): string {
  if (n > 0 && n < 0.01) return '<$0.01'
  return n >= 100 ? `$${Math.round(n)}` : `$${n.toFixed(2).replace(/\.00$/, '')}`
}

const plural = (n: number, one: string, many: string): string => `${n} ${n === 1 ? one : many}`

/** The computed status line: "2 requests in flight, 1 needs you, 3 done this week, $12 of $60 spent." */
export function statusSentence(facts: StatusFacts, extraNeedsYou = 0): string {
  const needsYou = facts.needsYou + extraNeedsYou
  const parts: string[] = []
  if (facts.requestsInFlight > 0)
    parts.push(`${plural(facts.requestsInFlight, 'request', 'requests')} in flight`)
  if (needsYou > 0) parts.push(`${needsYou} need${needsYou === 1 ? 's' : ''} you`)
  if (facts.doneLast7Days > 0) parts.push(`${facts.doneLast7Days} done this week`)
  if (facts.budgetLimitUsd !== null && facts.budgetSpentUsd !== null) {
    parts.push(`${usd(facts.budgetSpentUsd)} of ${usd(facts.budgetLimitUsd)} spent`)
  } else if (facts.spentLast7DaysUsd > 0) {
    parts.push(`${usd(facts.spentLast7DaysUsd)} spent this week`)
  }
  if (parts.length === 0) return 'Nothing in flight.'
  const text = parts.join(', ')
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`
}
