// ─── Readable task ids ──────────────────────────────────────────────────────
// A task's readable id is its team's prefix and a number, like `CLB-12`. Both the
// prefix and the number are taken inside the create's own BEGIN IMMEDIATE
// transaction, so two writers on this file (the server and the Tasks MCP's stdio
// bins are separate processes) cannot take the same one: the second waits for the
// first to commit, then reads what it wrote.
//
// A team keeps its prefix for life. The prefix is fixed by the team's first task
// and a rename changes nothing, so an id a person wrote down stays true. A deleted
// team's tasks keep their ids, so a prefix any task still carries is never given
// to another team: its numbers would start again and clash.

import {
  firstFreeTaskPrefix,
  formatTaskIdentifier,
  isTaskIdentifier,
  isValidTaskPrefix,
  normalizeTaskPrefix,
} from '@clawboo/board-core'
import { and, asc, eq, isNull, ne, sql } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { tasks, teams } from '../schema'
import { immediateWrite, type BoardTx } from './contention'

/** Is this prefix held by another team, or carried by any task? `-` sorts just
 *  before `.`, so the range is exactly the ids under this prefix, and the unique
 *  index on `identifier` serves it. */
function prefixInUse(tx: BoardTx | ClawbooDb, prefix: string, exceptTeamId?: string): boolean {
  const held = tx
    .select({ id: teams.id })
    .from(teams)
    .where(
      and(
        eq(teams.taskPrefix, prefix),
        ...(exceptTeamId !== undefined ? [ne(teams.id, exceptTeamId)] : []),
      ),
    )
    .get()
  if (held) return true
  return (
    tx
      .select({ id: tasks.id })
      .from(tasks)
      .where(sql`${tasks.identifier} >= ${`${prefix}-`} AND ${tasks.identifier} < ${`${prefix}.`}`)
      .limit(1)
      .get() !== undefined
  )
}

function identifierInUse(tx: BoardTx, identifier: string): boolean {
  return (
    tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.identifier, identifier)).get() !==
    undefined
  )
}

/**
 * Take the team's next readable id, choosing its prefix if this is its first. Null
 * for no team, or a team id with no row (`team_id` is a soft reference). Runs inside
 * the caller's write transaction: if the create rolls back, so does the number.
 */
export function allocateTaskIdentifier(tx: BoardTx, teamId: string | null): string | null {
  if (!teamId) return null
  const team = tx
    .select({ name: teams.name, prefix: teams.taskPrefix, next: teams.nextTaskNumber })
    .from(teams)
    .where(eq(teams.id, teamId))
    .get()
  if (!team) return null
  const prefix = team.prefix ?? firstFreeTaskPrefix(team.name, (p) => prefixInUse(tx, p))
  // Stepping over a used number costs one read. Failing on it would stop the whole
  // team from creating tasks over a counter someone edited by hand.
  let n = team.next
  while (identifierInUse(tx, formatTaskIdentifier(prefix, n))) n += 1
  tx.update(teams)
    .set({ taskPrefix: prefix, nextTaskNumber: n + 1 })
    .where(eq(teams.id, teamId))
    .run()
  return formatTaskIdentifier(prefix, n)
}

/**
 * Give every existing task of a team that still exists its readable id: oldest team
 * first, so it gets the first pick of a contested prefix, and oldest task first, so
 * the numbers read in order. Runs at every boot and does nothing once done. Touches
 * neither `updatedAt` (it orders the board) nor the lifecycle bus: nothing changed
 * that anyone is waiting on. Returns how many tasks it numbered.
 */
export function backfillTaskIdentifiers(db: ClawbooDb): number {
  const pendingRows = (tx: BoardTx | ClawbooDb) =>
    tx
      .select({ id: tasks.id, teamId: teams.id })
      .from(tasks)
      .innerJoin(teams, eq(teams.id, tasks.teamId))
      .where(isNull(tasks.identifier))
  // The steady state, read without taking the write lock.
  if (pendingRows(db).limit(1).get() === undefined) return 0
  return immediateWrite(db, (tx) => {
    const rows = pendingRows(tx)
      .orderBy(asc(teams.createdAt), asc(teams.id), asc(tasks.createdAt), asc(sql`${tasks}.rowid`))
      .all()
    for (const row of rows) {
      tx.update(tasks)
        .set({ identifier: allocateTaskIdentifier(tx, row.teamId) })
        .where(eq(tasks.id, row.id))
        .run()
    }
    return rows.length
  })
}

export interface TeamTaskPrefix {
  /** What the team holds; null until a person sets it or its first task takes it. */
  prefix: string | null
  /** What its first task would take now. Reserves nothing. */
  suggested: string
  /** The team has a task, so the prefix is fixed. */
  locked: boolean
}

function teamHasTask(tx: BoardTx | ClawbooDb, teamId: string): boolean {
  return (
    tx.select({ id: tasks.id }).from(tasks).where(eq(tasks.teamId, teamId)).limit(1).get() !==
    undefined
  )
}

export function readTeamTaskPrefix(db: ClawbooDb, teamId: string): TeamTaskPrefix | null {
  const team = db
    .select({ name: teams.name, prefix: teams.taskPrefix })
    .from(teams)
    .where(eq(teams.id, teamId))
    .get()
  if (!team) return null
  return {
    prefix: team.prefix,
    suggested: team.prefix ?? firstFreeTaskPrefix(team.name, (p) => prefixInUse(db, p)),
    locked: teamHasTask(db, teamId),
  }
}

export type SetTaskPrefixResult =
  { ok: true; prefix: string } | { ok: false; reason: 'not_found' | 'invalid' | 'taken' | 'locked' }

/** A person setting the team's prefix. Allowed until the team's first task exists. */
export function setTeamTaskPrefix(db: ClawbooDb, teamId: string, raw: string): SetTaskPrefixResult {
  const prefix = normalizeTaskPrefix(raw)
  return immediateWrite(db, (tx): SetTaskPrefixResult => {
    const team = tx
      .select({ prefix: teams.taskPrefix })
      .from(teams)
      .where(eq(teams.id, teamId))
      .get()
    if (!team) return { ok: false, reason: 'not_found' }
    if (!isValidTaskPrefix(prefix)) return { ok: false, reason: 'invalid' }
    if (team.prefix === prefix) return { ok: true, prefix }
    if (teamHasTask(tx, teamId)) return { ok: false, reason: 'locked' }
    if (prefixInUse(tx, prefix, teamId)) return { ok: false, reason: 'taken' }
    tx.update(teams).set({ taskPrefix: prefix }).where(eq(teams.id, teamId)).run()
    return { ok: true, prefix }
  })
}

/**
 * The task id behind a reference that is either an id or a readable id, in either
 * case; null when there is no such task. With `teamId`, a task of another team is no
 * such task, so a caller kept to its team cannot find out what another team's
 * readable id points at.
 */
export function resolveTaskRef(
  db: ClawbooDb,
  ref: string,
  scope: { teamId?: string } = {},
): string | null {
  const condition = isTaskIdentifier(ref)
    ? eq(tasks.identifier, ref.toUpperCase())
    : eq(tasks.id, ref)
  const row = db.select({ id: tasks.id, teamId: tasks.teamId }).from(tasks).where(condition).get()
  if (!row) return null
  return scope.teamId !== undefined && row.teamId !== scope.teamId ? null : row.id
}
