// A person's durable pause of an agent, a team or a whole task tree: nothing of
// theirs starts until they resume it. It is the scoped, lasting cousin of the
// server's engine hold, read at the same choke points. A row means paused, and
// resuming deletes the row, so there is no in-between state to get stuck in.
//
// A task tree is named by its root task, the same id the budgets call a mission,
// and is read when asked, not saved: a sub-task made during the pause is covered.
//
// A paused task stays in its status and keeps its agent. The one change a pause
// makes to a task is releasing one whose run it stopped from In progress to To do,
// and that run's ledger row says why (`PAUSED_RUN_CLASS`), so a resume needs no
// saved snapshot of statuses: the task fires again from its own ledger.

import { randomUUID } from 'node:crypto'

import { delegationTargetOf } from '@clawboo/board-core'
import { and, asc, eq, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { personJson, parsePersonJson, type PersonRecord } from '../person'
import { agents, pauses, teams, type DbPause } from '../schema'
import { withWriteRetry } from './contention'
import { readTaskRunnerInputs } from './runnerInputs'

export type PauseKind = 'agent' | 'team' | 'task_tree'

export const PAUSE_KINDS: readonly PauseKind[] = ['agent', 'team', 'task_tree']

export interface Pause {
  kind: PauseKind
  /** The agent or team id, or the task tree's root task id. */
  id: string
  /** What the person said it is for; null when they said nothing. */
  reason: string | null
  /** Who paused it, when a sign-in proxy vouched for them; null for the local person. */
  pausedBy: PersonRecord | null
  pausedAt: number
}

/** A run, as far as a pause cares: who it is for. Name whatever is known. */
export interface PauseSubject {
  agentId?: string | null
  teamId?: string | null
  taskId?: string | null
}

/** Why a start is refused: a pause, or a team that was archived. */
export type StartRefusal = Pause | { kind: 'archived_team'; id: string }

function fromRow(row: DbPause): Pause {
  return {
    kind: row.scopeKind as PauseKind,
    id: row.scopeId,
    reason: row.reason,
    pausedBy: parsePersonJson(row.pausedBy),
    pausedAt: row.createdAt,
  }
}

/** The root of the task tree `taskId` sits in (a top-level task is its own root). */
export function taskTreeRootId(db: ClawbooDb, taskId: string): string {
  // `UNION`, so the walk ends even on a parent cycle in a corrupt database.
  const row = db.get<{ id: string } | undefined>(
    sql`
      WITH RECURSIVE chain(id, parent) AS (
        SELECT id, parent_task_id FROM tasks WHERE id = ${taskId}
        UNION
        SELECT t.id, t.parent_task_id FROM tasks t JOIN chain c ON t.id = c.parent
      )
      SELECT id FROM chain WHERE parent IS NULL LIMIT 1
    `,
  )
  return row?.id ?? taskId
}

/** Pause it, or do nothing if it is already paused: the first pause stands. */
export function placePause(
  db: ClawbooDb,
  input: { kind: PauseKind; id: string; reason?: string | null; person?: PersonRecord | null },
): { pause: Pause; created: boolean } {
  const inserted = withWriteRetry(
    () =>
      db
        .insert(pauses)
        .values({
          id: randomUUID(),
          scopeKind: input.kind,
          scopeId: input.id,
          reason: input.reason ?? null,
          pausedBy: personJson(input.person),
          createdAt: Date.now(),
        })
        .onConflictDoNothing()
        .returning()
        .all() as DbPause[],
  )
  const row =
    inserted[0] ??
    (db
      .select()
      .from(pauses)
      .where(and(eq(pauses.scopeKind, input.kind), eq(pauses.scopeId, input.id)))
      .get() as DbPause)
  return { pause: fromRow(row), created: inserted.length > 0 }
}

/** Lift it. False when it was not paused. */
export function liftPause(db: ClawbooDb, kind: PauseKind, id: string): boolean {
  const removed = withWriteRetry(() =>
    db
      .delete(pauses)
      .where(and(eq(pauses.scopeKind, kind), eq(pauses.scopeId, id)))
      .returning({ id: pauses.id })
      .all(),
  )
  return removed.length > 0
}

/** Every pause, oldest first. */
export function listPauses(db: ClawbooDb): Pause[] {
  return (db.select().from(pauses).orderBy(asc(pauses.createdAt)).all() as DbPause[]).map(fromRow)
}

/** The team a subject counts under: the one its run is for, else its agent's own. */
export function subjectTeamId(db: ClawbooDb, subject: PauseSubject): string | null {
  if (subject.teamId) return subject.teamId
  if (!subject.agentId) return null
  return (
    db.select({ teamId: agents.teamId }).from(agents).where(eq(agents.id, subject.agentId)).get()
      ?.teamId ?? null
  )
}

/**
 * The pause that covers this subject, or null: its agent, then the task tree its
 * task sits in, then its team. An empty table, the usual case, costs one read.
 */
export function pauseFor(db: ClawbooDb, subject: PauseSubject): Pause | null {
  const all = listPauses(db)
  if (all.length === 0) return null
  const named = (kind: PauseKind, id: string | null | undefined): Pause | undefined =>
    id ? all.find((p) => p.kind === kind && p.id === id) : undefined
  const agent = named('agent', subject.agentId)
  if (agent) return agent
  if (subject.taskId && all.some((p) => p.kind === 'task_tree')) {
    const tree = named('task_tree', taskTreeRootId(db, subject.taskId))
    if (tree) return tree
  }
  return all.some((p) => p.kind === 'team')
    ? (named('team', subjectTeamId(db, subject)) ?? null)
    : null
}

/** What a task reads as a subject: the agent working on it, else the one it is bound
 *  to (a To do task has no assignee yet), else the one the task runner last ran it for. */
export function pauseSubjectOfTask(task: {
  id: string
  teamId?: string | null
  assigneeAgentId?: string | null
  sourceDelegationId?: string | null
  runnerInputs?: string | null
}): PauseSubject {
  return {
    agentId:
      task.assigneeAgentId ??
      delegationTargetOf(task.sourceDelegationId) ??
      readTaskRunnerInputs({ runnerInputs: task.runnerInputs ?? null })?.assigneeAgentId ??
      null,
    teamId: task.teamId ?? null,
    taskId: task.id,
  }
}

/** The pause that covers a task, or null. */
export function pauseForTask(
  db: ClawbooDb,
  task: Parameters<typeof pauseSubjectOfTask>[0],
): Pause | null {
  return pauseFor(db, pauseSubjectOfTask(task))
}

/** Is this team archived? An unknown team is not. */
export function isTeamArchived(db: ClawbooDb, teamId: string): boolean {
  const row = db
    .select({ isArchived: teams.isArchived })
    .from(teams)
    .where(eq(teams.id, teamId))
    .get()
  return row?.isArchived === 1
}

/**
 * THE check for anything that would start work on its own: why this subject may
 * not start now, or null when it may. A pause, or an archived team, whose agents
 * must not be woken by work left on its board. A person's 1:1 chat asks `pauseFor`
 * instead: an agent stays reachable after its team is archived.
 */
export function startRefusedBy(db: ClawbooDb, subject: PauseSubject): StartRefusal | null {
  const pause = pauseFor(db, subject)
  if (pause) return pause
  const teamId = subjectTeamId(db, subject)
  return teamId && isTeamArchived(db, teamId) ? { kind: 'archived_team', id: teamId } : null
}

/** `startRefusedBy` for a task. */
export function startRefusedByTask(
  db: ClawbooDb,
  task: Parameters<typeof pauseSubjectOfTask>[0],
): StartRefusal | null {
  return startRefusedBy(db, pauseSubjectOfTask(task))
}
