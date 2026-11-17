// The reads behind Home: goal progress and cost, a goal's own page, Needs you,
// requests in flight, spend and upcoming routines, assembled for one team or for
// every team. Files the agents made are read off disk by the server and added
// there; everything else is in the database.

import { and, asc, eq, inArray, isNotNull, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { runCostForTasks } from '../board/runCost'
import { scheduledRuns, taskQuestions, tasks, teams, toolCallApprovals } from '../schema'
import {
  goalHealthHistory,
  listTeamGoals,
  type GoalHealthChangeRecord,
  type TeamGoalRecord,
} from './goals'
import {
  kpiTiles,
  listSuggestedKpis,
  listTeamKpis,
  type KpiTileRecord,
  type TeamKpiRecord,
} from './kpis'
import {
  loadGoalTeams,
  loadTaskLinkRows,
  resolveGoalLinks,
  type GoalLinkVia,
  type TaskLinkRow,
} from './links'
import {
  checkOutcome,
  statusFacts,
  statusSentence,
  teamBudget,
  teamSnapshot,
  teamSpendIncludesEstimates,
  teamSpendUsd,
  type StatusFacts,
  type TeamSnapshot,
} from './metrics'
import { listTeamPages, type TeamPageRecord } from './pages'
import { freshLeadSummary, getTeamHomeSettings, type TeamHomeSettingsRecord } from './summary'
import { DAY_MS, type HomeActor } from './types'
import {
  lastPublishedByGoal,
  listDraftUpdates,
  listGoalUpdates,
  type GoalUpdateRecord,
} from './updates'

// ─── Goal summaries ──────────────────────────────────────────────────────────

export interface GoalProgressRecord {
  total: number
  done: number
  doneChecked: number
  addedLast7Days: number
  doneLast7Days: number
}

export interface GoalSummaryRecord {
  goal: TeamGoalRecord
  progress: GoalProgressRecord
  cost: { usd: number; includesEstimates: boolean }
  lastUpdateAt: number | null
  updateMissing: boolean
  draftCount: number
  childCount: number
}

interface LinkedTask {
  row: TaskLinkRow
  via: GoalLinkVia
  /** The goal it links to directly (a child's, under a parent's rollup). */
  goalId: string
}

/** Each goal's linked tasks; a parent goal also holds its children's. */
export interface GoalIndex {
  now: number
  byGoal: Map<string, LinkedTask[]>
}

export function buildGoalIndex(
  db: ClawbooDb,
  goals: readonly TeamGoalRecord[],
  teamIds: readonly string[],
  now = Date.now(),
): GoalIndex {
  const rows = loadTaskLinkRows(db, teamIds)
  const links = resolveGoalLinks(db, rows, loadGoalTeams(db))
  const direct = new Map<string, LinkedTask[]>()
  for (const row of rows) {
    const link = links.get(row.id)
    if (!link) continue
    const list = direct.get(link.goalId) ?? []
    list.push({ row, via: link.via, goalId: link.goalId })
    direct.set(link.goalId, list)
  }
  const byGoal = new Map<string, LinkedTask[]>()
  for (const goal of goals) {
    const own = direct.get(goal.id) ?? []
    const children = goals.filter((g) => g.parentGoalId === goal.id)
    byGoal.set(goal.id, [...own, ...children.flatMap((c) => direct.get(c.id) ?? [])])
  }
  return { now, byGoal }
}

const counted = (t: TaskLinkRow): boolean =>
  t.isMainTask !== 1 && t.dropped !== 1 && t.status !== 'cancelled'

function progressOf(linked: readonly LinkedTask[], now: number): GoalProgressRecord {
  const weekAgo = now - 7 * DAY_MS
  const work = linked.map((l) => l.row).filter(counted)
  const finished = work.filter((t) => t.status === 'done')
  return {
    total: work.length,
    done: finished.length,
    doneChecked: finished.filter((t) => checkOutcome(t.verification) === true).length,
    addedLast7Days: work.filter((t) => t.createdAt >= weekAgo).length,
    doneLast7Days: finished.filter((t) => (t.completedAt ?? t.updatedAt) >= weekAgo).length,
  }
}

function costOf(
  db: ClawbooDb,
  linked: readonly LinkedTask[],
): { usd: number; includesEstimates: boolean } {
  const rows = linked.map((l) => l.row).filter((t) => t.dropped !== 1)
  let usd = 0
  let includesEstimates = false
  for (const cost of runCostForTasks(db, rows).values()) {
    if (cost.usd !== null) usd += cost.usd
    if (cost.estimated) includesEstimates = true
  }
  return { usd, includesEstimates }
}

export function goalSummaries(
  db: ClawbooDb,
  goals: readonly TeamGoalRecord[],
  index: GoalIndex,
): GoalSummaryRecord[] {
  const ids = goals.map((g) => g.id)
  const published = lastPublishedByGoal(db, ids)
  const drafts = new Map<string, number>()
  for (const d of listDraftUpdates(db, [...new Set(goals.map((g) => g.teamId))]))
    drafts.set(d.goalId, (drafts.get(d.goalId) ?? 0) + 1)
  return goals.map((goal) => {
    const linked = index.byGoal.get(goal.id) ?? []
    const lastUpdateAt = published.get(goal.id) ?? null
    const since = lastUpdateAt ?? goal.createdAt
    return {
      goal,
      progress: progressOf(linked, index.now),
      cost: costOf(db, linked),
      lastUpdateAt,
      updateMissing:
        goal.status === 'active' &&
        goal.archivedAt === null &&
        index.now - since > goal.updateCadenceDays * DAY_MS,
      draftCount: drafts.get(goal.id) ?? 0,
      childCount: goals.filter((g) => g.parentGoalId === goal.id && g.archivedAt === null).length,
    }
  })
}

// ─── A goal's own page ───────────────────────────────────────────────────────

export interface GoalTaskRecord {
  taskId: string
  identifier: string | null
  title: string
  status: string
  isMainTask: boolean
  assigneeAgentId: string | null
  costUsd: number
  checked: boolean | null
  linkedVia: GoalLinkVia
  dropped: boolean
  createdAt: number
  completedAt: number | null
}

export interface GoalDetailRecord {
  summary: GoalSummaryRecord
  parent: { id: string; title: string } | null
  children: GoalSummaryRecord[]
  healthHistory: GoalHealthChangeRecord[]
  tasks: GoalTaskRecord[]
  kpis: KpiTileRecord[]
  updates: GoalUpdateRecord[]
  pages: TeamPageRecord[]
}

export function goalDetail(
  db: ClawbooDb,
  teamId: string,
  goalId: string,
  now = Date.now(),
): GoalDetailRecord | null {
  const goals = listTeamGoals(db, teamId, { includeArchived: true })
  const goal = goals.find((g) => g.id === goalId)
  if (!goal) return null
  const index = buildGoalIndex(db, goals, [teamId], now)
  const children = goals.filter((g) => g.parentGoalId === goal.id && g.archivedAt === null)
  const [summary, ...childSummaries] = goalSummaries(db, [goal, ...children], index)
  const linked = index.byGoal.get(goal.id) ?? []
  const costs = runCostForTasks(
    db,
    linked.map((l) => l.row),
  )
  const parent = goal.parentGoalId ? goals.find((g) => g.id === goal.parentGoalId) : undefined
  const snap = teamSnapshot(db, teamId, now)
  const kpis = listTeamKpis(db, teamId, { statuses: ['active'] }).filter(
    (k) => k.goalId === goal.id,
  )
  return {
    summary: summary!,
    parent: parent ? { id: parent.id, title: parent.title } : null,
    children: childSummaries,
    healthHistory: goalHealthHistory(db, goal.id),
    tasks: linked
      .map((l) => ({
        taskId: l.row.id,
        identifier: l.row.identifier,
        title: l.row.title,
        status: l.row.status,
        isMainTask: l.row.isMainTask === 1,
        assigneeAgentId: l.row.assigneeAgentId,
        costUsd: costs.get(l.row.id)?.usd ?? 0,
        checked: checkOutcome(l.row.verification),
        linkedVia: l.via,
        dropped: l.row.dropped === 1,
        createdAt: l.row.createdAt,
        completedAt: l.row.completedAt,
      }))
      .sort((a, b) => b.createdAt - a.createdAt),
    kpis: kpiTiles(db, kpis, snap),
    updates: listGoalUpdates(db, goal.id),
    pages: listTeamPages(db, teamId, { goalId: goal.id }),
  }
}

// ─── Needs you ───────────────────────────────────────────────────────────────

export interface HomeNeedsYouRecord {
  total: number
  tasks: Array<{
    taskId: string
    identifier: string | null
    title: string
    teamId: string | null
    reason: string
  }>
  approvals: number
  questions: number
  draftUpdates: Array<{
    updateId: string
    goalId: string
    goalTitle: string
    teamId: string
    author: HomeActor | null
    createdAt: number
  }>
  suggestedKpis: Array<{
    kpiId: string
    name: string
    teamId: string
    goalId: string | null
    suggestedBy: HomeActor | null
    note: string | null
    createdAt: number
  }>
}

function pendingApprovals(db: ClawbooDb, agentIds: readonly string[]): number {
  if (agentIds.length === 0) return 0
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(toolCallApprovals)
    .where(
      and(
        eq(toolCallApprovals.status, 'pending'),
        inArray(toolCallApprovals.agentId, [...agentIds]),
      ),
    )
    .get()
  return Number(row?.n ?? 0)
}

function pendingQuestions(db: ClawbooDb, teamIds: readonly string[]): number {
  if (teamIds.length === 0) return 0
  const row = db
    .select({ n: sql<number>`count(*)` })
    .from(taskQuestions)
    .innerJoin(tasks, eq(tasks.id, taskQuestions.taskId))
    .where(and(eq(taskQuestions.status, 'pending'), inArray(tasks.teamId, [...teamIds])))
    .get()
  return Number(row?.n ?? 0)
}

export function needsYou(
  db: ClawbooDb,
  snaps: readonly TeamSnapshot[],
  goalTitles: ReadonlyMap<string, string>,
): HomeNeedsYouRecord {
  const teamIds = snaps.map((s) => s.teamId)
  const taskItems = snaps.flatMap((snap) =>
    snap.tasks
      .filter((t) => snap.attention.has(t.id))
      .map((t) => ({
        taskId: t.id,
        identifier: t.identifier ?? null,
        title: t.title,
        teamId: t.teamId ?? null,
        reason: snap.attention.get(t.id)!.reason as string,
      })),
  )
  const draftUpdates = listDraftUpdates(db, teamIds).map((d) => ({
    updateId: d.id,
    goalId: d.goalId,
    goalTitle: goalTitles.get(d.goalId) ?? '',
    teamId: d.teamId,
    author: d.author,
    createdAt: d.createdAt,
  }))
  const suggestedKpis = listSuggestedKpis(db, teamIds).map((k) => ({
    kpiId: k.id,
    name: k.name,
    teamId: k.teamId,
    goalId: k.goalId,
    suggestedBy: k.suggestedBy,
    note: k.suggestionNote,
    createdAt: k.createdAt,
  }))
  const approvals = pendingApprovals(
    db,
    snaps.flatMap((s) => s.agentIds),
  )
  return {
    // A question waits on its task, so it is counted with the tasks.
    total: taskItems.length + approvals + draftUpdates.length + suggestedKpis.length,
    tasks: taskItems,
    approvals,
    questions: pendingQuestions(db, teamIds),
    draftUpdates,
    suggestedKpis,
  }
}

// ─── The rest of a team's Home ───────────────────────────────────────────────

export interface HomeInFlightRecord {
  taskId: string
  identifier: string | null
  title: string
  status: string
  goalId: string | null
  leadAgentId: string | null
  subtaskCount: number
  subtasksDone: number
  createdAt: number
  updatedAt: number
}

function subtreeCounts(db: ClawbooDb, taskId: string): { total: number; done: number } {
  const row = db.get(
    sql`
      WITH RECURSIVE below(id) AS (
        SELECT id FROM tasks WHERE parent_task_id = ${taskId} AND dropped = 0
        UNION
        SELECT t.id FROM tasks t JOIN below b ON t.parent_task_id = b.id WHERE t.dropped = 0
      )
      SELECT count(*) AS total,
             coalesce(sum(CASE WHEN status = 'done' THEN 1 ELSE 0 END), 0) AS done
      FROM tasks WHERE id IN (SELECT id FROM below) AND status != 'cancelled'
    `,
  ) as { total?: number; done?: number } | undefined
  return { total: Number(row?.total ?? 0), done: Number(row?.done ?? 0) }
}

export function inFlightRequests(
  db: ClawbooDb,
  snap: TeamSnapshot,
  limit = 20,
): HomeInFlightRecord[] {
  return snap.tasks
    .filter((t) => t.isMainTask === 1 && t.status !== 'done' && t.status !== 'cancelled')
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, limit)
    .map((t) => {
      const counts = subtreeCounts(db, t.id)
      return {
        taskId: t.id,
        identifier: t.identifier ?? null,
        title: t.title,
        status: t.status,
        goalId: t.goalId ?? null,
        leadAgentId: t.assigneeAgentId ?? null,
        subtaskCount: counts.total,
        subtasksDone: counts.done,
        createdAt: t.createdAt,
        updatedAt: t.updatedAt,
      }
    })
}

export interface HomeSpendRecord {
  last7DaysUsd: number
  last30DaysUsd: number
  includesEstimates: boolean
  budget: { limitUsd: number; spentUsd: number; mode: string; status: string } | null
}

export function teamSpend(db: ClawbooDb, snap: TeamSnapshot): HomeSpendRecord {
  const monthAgo = snap.now - 30 * DAY_MS
  return {
    last7DaysUsd: teamSpendUsd(db, snap, snap.now - 7 * DAY_MS),
    last30DaysUsd: teamSpendUsd(db, snap, monthAgo),
    includesEstimates: teamSpendIncludesEstimates(db, snap.teamId, monthAgo),
    budget: teamBudget(db, snap.teamId),
  }
}

export interface HomeRoutineRecord {
  id: string
  name: string
  target: string
  agentId: string | null
  nextRunAt: number
  status: string
}

export function upcomingRoutines(db: ClawbooDb, teamId: string, limit = 5): HomeRoutineRecord[] {
  return db
    .select()
    .from(scheduledRuns)
    .where(
      and(
        eq(scheduledRuns.teamId, teamId),
        inArray(scheduledRuns.status, ['idle', 'queued']),
        isNotNull(scheduledRuns.nextRunAt),
      ),
    )
    .orderBy(asc(scheduledRuns.nextRunAt))
    .limit(limit)
    .all()
    .map((r) => {
      let name = 'Routine'
      let target = 'agent'
      try {
        const t = JSON.parse(r.taskTemplate) as { title?: unknown; target?: unknown }
        if (typeof t.title === 'string' && t.title) name = t.title
        if (t.target === 'team') target = 'team'
      } catch {
        /* an unreadable template keeps the defaults */
      }
      return {
        id: r.id,
        name,
        target,
        agentId: r.agentId || null,
        nextRunAt: r.nextRunAt!,
        status: r.status,
      }
    })
}

export interface HomeStatusLineRecord {
  text: string
  source: 'computed' | 'lead'
  asOf: number
  author: HomeActor | null
  executionId: string | null
  model: string | null
  facts: StatusFacts
}

export function statusLine(
  db: ClawbooDb,
  snap: TeamSnapshot,
  needs: Pick<HomeNeedsYouRecord, 'total' | 'tasks'>,
): HomeStatusLineRecord {
  const facts = { ...statusFacts(db, snap), needsYou: needs.total }
  const lead = freshLeadSummary(db, snap.teamId, snap.now)
  if (lead)
    return {
      text: lead.body,
      source: 'lead',
      asOf: lead.writtenAt,
      author: lead.author,
      executionId: lead.executionId,
      model: lead.model,
      facts,
    }
  return {
    text: statusSentence(facts),
    source: 'computed',
    asOf: snap.now,
    author: null,
    executionId: null,
    model: null,
    facts,
  }
}

export interface HomeTeamRefRecord {
  id: string
  name: string
  icon: string | null
  color: string | null
  leaderAgentId: string | null
}

function teamRefs(db: ClawbooDb, teamIds?: readonly string[]): HomeTeamRefRecord[] {
  const rows = db
    .select({
      id: teams.id,
      name: teams.name,
      icon: teams.icon,
      color: teams.color,
      leaderAgentId: teams.leaderAgentId,
      isArchived: teams.isArchived,
    })
    .from(teams)
    .orderBy(asc(teams.name))
    .all()
  return rows
    .filter((t) => (teamIds ? teamIds.includes(t.id) : t.isArchived !== 1))
    .map((t) => ({
      id: t.id,
      name: t.name,
      icon: t.icon || null,
      color: t.color || null,
      leaderAgentId: t.leaderAgentId ?? null,
    }))
}

export interface TeamHomeRecord<F = unknown> {
  team: HomeTeamRefRecord
  asOf: number
  status: HomeStatusLineRecord
  settings: TeamHomeSettingsRecord
  needsYou: HomeNeedsYouRecord
  goals: GoalSummaryRecord[]
  kpis: KpiTileRecord[]
  inFlight: HomeInFlightRecord[]
  spend: HomeSpendRecord
  routines: HomeRoutineRecord[]
  pinnedPages: TeamPageRecord[]
  recentFiles: F[]
}

/** One team's Home, without the files (the server reads those off disk). Null for no such team. */
export function teamHome(
  db: ClawbooDb,
  teamId: string,
  now = Date.now(),
): TeamHomeRecord<never> | null {
  const team = teamRefs(db, [teamId])[0]
  if (!team) return null
  const snap = teamSnapshot(db, teamId, now)
  const goals = listTeamGoals(db, teamId).filter((g) => g.status === 'active')
  const index = buildGoalIndex(db, goals, [teamId], now)
  const allGoals = listTeamGoals(db, teamId, { includeArchived: true })
  const needs = needsYou(db, [snap], new Map(allGoals.map((g) => [g.id, g.title])))
  return {
    team,
    asOf: now,
    status: statusLine(db, snap, needs),
    settings: getTeamHomeSettings(db, teamId),
    needsYou: needs,
    goals: goalSummaries(db, goals, index),
    kpis: kpiTiles(db, listTeamKpis(db, teamId, { statuses: ['active'] }), snap),
    inFlight: inFlightRequests(db, snap),
    spend: teamSpend(db, snap),
    routines: upcomingRoutines(db, teamId),
    pinnedPages: listTeamPages(db, teamId, { pinnedOnly: true }),
    recentFiles: [],
  }
}

export interface AllTeamsHomeRecord {
  asOf: number
  teams: Array<{
    team: HomeTeamRefRecord
    status: HomeStatusLineRecord
    goals: GoalSummaryRecord[]
    kpis: KpiTileRecord[]
    needsYouCount: number
    spend: HomeSpendRecord
  }>
  totals: {
    requestsInFlight: number
    needsYou: number
    doneLast7Days: number
    spentLast7DaysUsd: number
    goalsActive: number
    goalsAtRisk: number
    goalsOffTrack: number
  }
  needsYou: HomeNeedsYouRecord
}

/** How many KPIs each team's row shows on the All teams Home. */
export const ALL_TEAMS_KPIS_PER_TEAM = 3

/** Every team's headline numbers. `teamIds` cuts it to those teams (a guest's). */
export function allTeamsHome(
  db: ClawbooDb,
  opts: { teamIds?: readonly string[]; now?: number } = {},
): AllTeamsHomeRecord {
  const now = opts.now ?? Date.now()
  const refs = teamRefs(db).filter((t) => !opts.teamIds || opts.teamIds.includes(t.id))
  const ids = refs.map((t) => t.id)
  const snaps = refs.map((t) => teamSnapshot(db, t.id, now))
  const goals = ids.flatMap((id) => listTeamGoals(db, id))
  const active = goals.filter((g) => g.status === 'active')
  const index = buildGoalIndex(db, active, ids, now)
  const summaries = goalSummaries(db, active, index)
  const needs = needsYou(db, snaps, new Map(goals.map((g) => [g.id, g.title])))
  const rows = refs.map((team, i) => {
    const snap = snaps[i]!
    const own = needsYou(db, [snap], new Map(goals.map((g) => [g.id, g.title])))
    const kpis: TeamKpiRecord[] = listTeamKpis(db, team.id, { statuses: ['active'] }).slice(
      0,
      ALL_TEAMS_KPIS_PER_TEAM,
    )
    return {
      team,
      status: statusLine(db, snap, own),
      goals: summaries.filter((s) => s.goal.teamId === team.id),
      kpis: kpiTiles(db, kpis, snap),
      needsYouCount: own.total,
      spend: teamSpend(db, snap),
    }
  })
  return {
    asOf: now,
    teams: rows,
    totals: {
      requestsInFlight: rows.reduce((n, r) => n + r.status.facts.requestsInFlight, 0),
      needsYou: needs.total,
      doneLast7Days: rows.reduce((n, r) => n + r.status.facts.doneLast7Days, 0),
      spentLast7DaysUsd: rows.reduce((n, r) => n + r.spend.last7DaysUsd, 0),
      goalsActive: active.length,
      goalsAtRisk: active.filter((g) => g.health === 'at_risk').length,
      goalsOffTrack: active.filter((g) => g.health === 'off_track').length,
    },
    needsYou: needs,
  }
}
