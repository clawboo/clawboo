// Which goal a task serves.
//
// A task's goal is its own `goal_id`, else the nearest one up its parent chain,
// which is its request's (the main task above it) when nothing between names
// another. Every create path copies the parent's goal
// down when it makes the row (`goalForNewTaskTx`, called from `insertTask`), so
// stored rows are right; the read-time resolver below covers tasks made before
// their request had a goal, which is how linking a request later takes its work
// along.
//
// A task only ever serves a goal of its own team. A goal from another team (a
// hand-off filed under another team's request, or a task that changed teams)
// counts as no goal, at creation and on read.

import { eq, inArray } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import type { BoardTx } from '../board/contention'
import { teamGoals, tasks } from '../schema'

/** The columns Home reads off a task. */
export interface TaskLinkRow {
  id: string
  teamId: string | null
  parentTaskId: string | null
  goalId: string | null
  isMainTask: number
  status: string
  dropped: number
  costUsd: number
  verification: string | null
  identifier: string | null
  title: string
  assigneeAgentId: string | null
  createdAt: number
  updatedAt: number
  completedAt: number | null
}

const LINK_COLUMNS = {
  id: tasks.id,
  teamId: tasks.teamId,
  parentTaskId: tasks.parentTaskId,
  goalId: tasks.goalId,
  isMainTask: tasks.isMainTask,
  status: tasks.status,
  dropped: tasks.dropped,
  costUsd: tasks.costUsd,
  verification: tasks.verification,
  identifier: tasks.identifier,
  title: tasks.title,
  assigneeAgentId: tasks.assigneeAgentId,
  createdAt: tasks.createdAt,
  updatedAt: tasks.updatedAt,
  completedAt: tasks.completedAt,
}

export type GoalLinkVia = 'own' | 'request' | 'parent'

export interface GoalLink {
  goalId: string
  via: GoalLinkVia
}

/** How far up a parent chain a resolve looks. Deeper chains are refused at create. */
const MAX_WALK = 32

/** Every task of these teams (all teams with none given), dropped ones included. */
export function loadTaskLinkRows(db: ClawbooDb, teamIds?: readonly string[]): TaskLinkRow[] {
  const q = db.select(LINK_COLUMNS).from(tasks)
  if (!teamIds) return q.all() as TaskLinkRow[]
  if (teamIds.length === 0) return []
  return q.where(inArray(tasks.teamId, [...teamIds])).all() as TaskLinkRow[]
}

/** goal id -> team id, for every goal (archived ones too: their tasks keep the link). */
export function loadGoalTeams(db: ClawbooDb | BoardTx): Map<string, string> {
  const out = new Map<string, string>()
  for (const g of db.select({ id: teamGoals.id, teamId: teamGoals.teamId }).from(teamGoals).all())
    out.set(g.id, g.teamId)
  return out
}

/**
 * Resolve each row's goal. Parents that are not among `rows` (work filed under
 * another team's request) are read one by one, and only as far as needed.
 */
export function resolveGoalLinks(
  db: ClawbooDb,
  rows: readonly TaskLinkRow[],
  goalTeams: ReadonlyMap<string, string>,
): Map<string, GoalLink | null> {
  const byId = new Map<string, TaskLinkRow>()
  for (const r of rows) byId.set(r.id, r)
  const lookup = (id: string): TaskLinkRow | undefined => {
    const known = byId.get(id)
    if (known) return known
    const row = db.select(LINK_COLUMNS).from(tasks).where(eq(tasks.id, id)).get() as
      TaskLinkRow | undefined
    if (row) byId.set(row.id, row)
    return row
  }
  const out = new Map<string, GoalLink | null>()
  for (const r of rows) out.set(r.id, resolveOne(r, lookup, goalTeams))
  return out
}

function resolveOne(
  task: Pick<TaskLinkRow, 'teamId' | 'goalId' | 'parentTaskId'>,
  lookup: (
    id: string,
  ) => Pick<TaskLinkRow, 'id' | 'goalId' | 'parentTaskId' | 'isMainTask'> | undefined,
  goalTeams: ReadonlyMap<string, string>,
): GoalLink | null {
  const counts = (goalId: string | null): goalId is string =>
    goalId !== null && task.teamId !== null && goalTeams.get(goalId) === task.teamId
  if (counts(task.goalId)) return { goalId: task.goalId, via: 'own' }
  // The nearest goal up the chain: the request's when nothing between has one.
  const seen = new Set<string>()
  let cursor = task.parentTaskId
  for (let steps = 0; cursor && steps < MAX_WALK && !seen.has(cursor); steps++) {
    seen.add(cursor)
    const row = lookup(cursor)
    if (!row) break
    if (counts(row.goalId)) {
      return { goalId: row.goalId, via: row.isMainTask === 1 ? 'request' : 'parent' }
    }
    // Above a request is nothing of its own: a request is where its work starts.
    if (row.isMainTask === 1) break
    cursor = row.parentTaskId
  }
  return null
}

/** Is `goalId` a goal of `teamId`? Archived goals count: a task may stay linked. */
export function goalIsOnTeam(
  db: ClawbooDb | BoardTx,
  goalId: string,
  teamId: string | null | undefined,
): boolean {
  if (!teamId) return false
  const row = db
    .select({ teamId: teamGoals.teamId })
    .from(teamGoals)
    .where(eq(teamGoals.id, goalId))
    .get()
  return row?.teamId === teamId
}

/**
 * The goal a new task gets, inside its create's write. An explicit goal stands
 * when it is on the task's team (else none); with none given, the goal its
 * parent resolves to, when that is on the task's team.
 */
export function goalForNewTaskTx(
  tx: BoardTx,
  row: { teamId: string | null; parentTaskId: string | null },
  explicit: string | null | undefined,
): string | null {
  if (explicit !== undefined) {
    return explicit && goalIsOnTeam(tx, explicit, row.teamId) ? explicit : null
  }
  if (!row.parentTaskId || !row.teamId) return null
  const lookup = (id: string) =>
    tx
      .select({
        id: tasks.id,
        goalId: tasks.goalId,
        parentTaskId: tasks.parentTaskId,
        isMainTask: tasks.isMainTask,
      })
      .from(tasks)
      .where(eq(tasks.id, id))
      .get()
  const goalTeams = new Map<string, string>()
  const teamOf = (goalId: string): void => {
    if (goalTeams.has(goalId)) return
    const g = tx
      .select({ teamId: teamGoals.teamId })
      .from(teamGoals)
      .where(eq(teamGoals.id, goalId))
      .get()
    if (g) goalTeams.set(goalId, g.teamId)
  }
  // Read the goals the chain names first, so the pure resolve can check teams.
  const seen = new Set<string>()
  let cursor: string | null = row.parentTaskId
  for (let steps = 0; cursor && steps < MAX_WALK && !seen.has(cursor); steps++) {
    seen.add(cursor)
    const r = lookup(cursor)
    if (!r) break
    if (r.goalId) teamOf(r.goalId)
    if (r.isMainTask === 1) break
    cursor = r.parentTaskId
  }
  const link = resolveOne(
    { teamId: row.teamId, goalId: null, parentTaskId: row.parentTaskId },
    lookup,
    goalTeams,
  )
  return link?.goalId ?? null
}

/** One task's goal, as the resolver reads it, or null. */
export function resolveTaskGoal(db: ClawbooDb, taskId: string): GoalLink | null {
  const row = db.select(LINK_COLUMNS).from(tasks).where(eq(tasks.id, taskId)).get() as
    TaskLinkRow | undefined
  if (!row) return null
  return resolveGoalLinks(db, [row], loadGoalTeams(db)).get(row.id) ?? null
}
