// ─── Labels ─────────────────────────────────────────────────────────────────
// A team's own words for sorting its board. A label belongs to one team, and a task
// carries only its own team's. Names compare without case or surrounding spaces, so
// `Bug` and ` bug` are one label.

import { randomUUID } from 'node:crypto'

import { and, asc, count, eq, inArray } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { labels, taskLabels, tasks, teams, type DbLabel } from '../schema'
import { immediateWrite, withWriteRetry, type BoardTx } from './contention'

export const MAX_LABEL_NAME_CHARS = 40
export const MAX_LABELS_PER_TEAM = 100
export const MAX_LABELS_PER_TASK = 10

export interface TaskLabel {
  id: string
  name: string
}

export type LabelWriteResult =
  | { ok: true; label: DbLabel }
  | { ok: false; reason: 'not_found' | 'invalid' | 'taken' | 'too_many' }

const nameKeyOf = (name: string): string => name.trim().toLowerCase()

const validName = (name: string): boolean => {
  const trimmed = name.trim()
  return trimmed.length > 0 && trimmed.length <= MAX_LABEL_NAME_CHARS
}

function nameTaken(tx: BoardTx, teamId: string, nameKey: string, exceptId?: string): boolean {
  const row = tx
    .select({ id: labels.id })
    .from(labels)
    .where(and(eq(labels.teamId, teamId), eq(labels.nameKey, nameKey)))
    .get()
  return row !== undefined && row.id !== exceptId
}

export function listLabels(db: ClawbooDb, teamId: string): DbLabel[] {
  return db
    .select()
    .from(labels)
    .where(eq(labels.teamId, teamId))
    .orderBy(asc(labels.nameKey))
    .all() as DbLabel[]
}

export function createLabel(db: ClawbooDb, teamId: string, name: string): LabelWriteResult {
  return immediateWrite(db, (tx): LabelWriteResult => {
    if (!tx.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).get()) {
      return { ok: false, reason: 'not_found' }
    }
    if (!validName(name)) return { ok: false, reason: 'invalid' }
    const nameKey = nameKeyOf(name)
    if (nameTaken(tx, teamId, nameKey)) return { ok: false, reason: 'taken' }
    const held = tx.select({ n: count() }).from(labels).where(eq(labels.teamId, teamId)).get()
    if ((held?.n ?? 0) >= MAX_LABELS_PER_TEAM) return { ok: false, reason: 'too_many' }
    const now = Date.now()
    const label: DbLabel = {
      id: randomUUID(),
      teamId,
      name: name.trim(),
      nameKey,
      createdAt: now,
      updatedAt: now,
    }
    tx.insert(labels).values(label).run()
    return { ok: true, label }
  })
}

export function renameLabel(
  db: ClawbooDb,
  teamId: string,
  labelId: string,
  name: string,
): LabelWriteResult {
  return immediateWrite(db, (tx): LabelWriteResult => {
    const here = and(eq(labels.id, labelId), eq(labels.teamId, teamId))
    if (!tx.select({ id: labels.id }).from(labels).where(here).get()) {
      return { ok: false, reason: 'not_found' }
    }
    if (!validName(name)) return { ok: false, reason: 'invalid' }
    const nameKey = nameKeyOf(name)
    if (nameTaken(tx, teamId, nameKey, labelId)) return { ok: false, reason: 'taken' }
    tx.update(labels).set({ name: name.trim(), nameKey, updatedAt: Date.now() }).where(here).run()
    return { ok: true, label: tx.select().from(labels).where(here).get() as DbLabel }
  })
}

/** Remove a label from the team and from every task carrying it. False when the
 *  team has no such label. */
export function deleteLabel(db: ClawbooDb, teamId: string, labelId: string): boolean {
  const removed = withWriteRetry(() =>
    db
      .delete(labels)
      .where(and(eq(labels.id, labelId), eq(labels.teamId, teamId)))
      .run(),
  )
  return removed.changes > 0
}

export type SetTaskLabelsResult =
  | { ok: true; labels: TaskLabel[] }
  | { ok: false; reason: 'not_found' | 'label_not_in_team' | 'too_many' }

/** Replace a task's labels with this set, in one write. */
export function setTaskLabels(
  db: ClawbooDb,
  taskId: string,
  labelIds: readonly string[],
): SetTaskLabelsResult {
  const wanted = [...new Set(labelIds)]
  return immediateWrite(db, (tx): SetTaskLabelsResult => {
    const task = tx.select({ teamId: tasks.teamId }).from(tasks).where(eq(tasks.id, taskId)).get()
    if (!task) return { ok: false, reason: 'not_found' }
    if (wanted.length > MAX_LABELS_PER_TASK) return { ok: false, reason: 'too_many' }
    const found =
      wanted.length === 0 || !task.teamId
        ? []
        : (tx
            .select({ id: labels.id, name: labels.name })
            .from(labels)
            .where(and(eq(labels.teamId, task.teamId), inArray(labels.id, wanted)))
            .orderBy(asc(labels.nameKey))
            .all() as TaskLabel[])
    if (found.length !== wanted.length) return { ok: false, reason: 'label_not_in_team' }
    tx.delete(taskLabels).where(eq(taskLabels.taskId, taskId)).run()
    const now = Date.now()
    for (const label of found) {
      tx.insert(taskLabels).values({ taskId, labelId: label.id, createdAt: now }).run()
    }
    return { ok: true, labels: found }
  })
}

/** Each task's labels, by name, in one read, so a board of any size costs one query.
 *  A task with none is absent. */
export function labelsForTasks(
  db: ClawbooDb,
  taskIds: readonly string[],
): Map<string, TaskLabel[]> {
  const out = new Map<string, TaskLabel[]>()
  if (taskIds.length === 0) return out
  const rows = db
    .select({ taskId: taskLabels.taskId, id: labels.id, name: labels.name })
    .from(taskLabels)
    .innerJoin(labels, eq(labels.id, taskLabels.labelId))
    .where(inArray(taskLabels.taskId, [...taskIds]))
    .orderBy(asc(labels.nameKey))
    .all()
  for (const row of rows) {
    const list = out.get(row.taskId)
    if (list) list.push({ id: row.id, name: row.name })
    else out.set(row.taskId, [{ id: row.id, name: row.name }])
  }
  return out
}
