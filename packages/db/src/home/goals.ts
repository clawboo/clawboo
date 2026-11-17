// A team's goals: flat, each optionally under one parent goal of the same team.
// Only a person creates, edits, archives or sets the health of a goal; agents read
// them (the Tasks tools) and draft updates (updates.ts).

import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, isNull } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { immediateWrite, type BoardTx } from '../board/contention'
import { agents, teamGoalHealth, teamGoals, teams, type DbTeamGoal } from '../schema'
import {
  actorJson,
  cleanTitle,
  done,
  GOAL_HEALTHS,
  GOAL_STATUSES,
  HOME_DESCRIPTION_MAX_CHARS,
  MAX_GOALS_PER_TEAM,
  MAX_UPDATE_CADENCE_DAYS,
  parseActor,
  refuse,
  type GoalHealth,
  type GoalStatus,
  type HomeActor,
  type HomeResult,
} from './types'

export interface TeamGoalRecord {
  id: string
  teamId: string
  parentGoalId: string | null
  title: string
  description: string
  owner: HomeActor | null
  targetDate: number | null
  status: GoalStatus
  health: GoalHealth | null
  healthSetBy: HomeActor | null
  healthSetAt: number | null
  updateCadenceDays: number
  position: number
  createdBy: HomeActor | null
  createdAt: number
  updatedAt: number
  archivedAt: number | null
}

export interface GoalHealthChangeRecord {
  health: GoalHealth | null
  setBy: HomeActor | null
  setAt: number
  updateId: string | null
}

const isHealth = (v: unknown): v is GoalHealth =>
  typeof v === 'string' && (GOAL_HEALTHS as readonly string[]).includes(v)
const isStatus = (v: unknown): v is GoalStatus =>
  typeof v === 'string' && (GOAL_STATUSES as readonly string[]).includes(v)

export function toGoalRecord(row: DbTeamGoal): TeamGoalRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    parentGoalId: row.parentGoalId ?? null,
    title: row.title,
    description: row.description ?? '',
    owner: parseActor(row.owner),
    targetDate: row.targetDate ?? null,
    status: isStatus(row.status) ? row.status : 'active',
    health: isHealth(row.health) ? row.health : null,
    healthSetBy: parseActor(row.healthSetBy),
    healthSetAt: row.healthSetAt ?? null,
    updateCadenceDays: row.updateCadenceDays,
    position: row.position,
    createdBy: parseActor(row.createdBy),
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    archivedAt: row.archivedAt ?? null,
  }
}

function goalRowTx(
  db: ClawbooDb | BoardTx,
  teamId: string,
  goalId: string,
): DbTeamGoal | undefined {
  return db
    .select()
    .from(teamGoals)
    .where(and(eq(teamGoals.id, goalId), eq(teamGoals.teamId, teamId)))
    .get()
}

/** An agent as Home records it: its id and its registry name. */
export function agentActorOf(db: ClawbooDb | BoardTx, agentId: string): HomeActor {
  const row = db.select({ name: agents.name }).from(agents).where(eq(agents.id, agentId)).get()
  return { kind: 'agent', id: agentId, name: row?.name ?? null }
}

export function teamExistsForHome(db: ClawbooDb | BoardTx, teamId: string): boolean {
  return db.select({ id: teams.id }).from(teams).where(eq(teams.id, teamId)).get() !== undefined
}

/** A team's goals by position; archived ones only when asked for. */
export function listTeamGoals(
  db: ClawbooDb,
  teamId: string,
  opts: { includeArchived?: boolean } = {},
): TeamGoalRecord[] {
  const where = opts.includeArchived
    ? eq(teamGoals.teamId, teamId)
    : and(eq(teamGoals.teamId, teamId), isNull(teamGoals.archivedAt))
  return db
    .select()
    .from(teamGoals)
    .where(where)
    .orderBy(asc(teamGoals.position), asc(teamGoals.createdAt))
    .all()
    .map(toGoalRecord)
}

/** Every goal of every team that is not archived (the All teams Home). */
export function listAllActiveGoals(db: ClawbooDb): TeamGoalRecord[] {
  return db
    .select()
    .from(teamGoals)
    .where(isNull(teamGoals.archivedAt))
    .orderBy(asc(teamGoals.position), asc(teamGoals.createdAt))
    .all()
    .map(toGoalRecord)
}

/** One goal of this team, or null (a goal of another team is null too). */
export function getTeamGoal(db: ClawbooDb, teamId: string, goalId: string): TeamGoalRecord | null {
  const row = goalRowTx(db, teamId, goalId)
  return row ? toGoalRecord(row) : null
}

export interface GoalFields {
  title?: string
  description?: string
  parentGoalId?: string | null
  owner?: HomeActor | null
  targetDate?: number | null
  status?: GoalStatus
  updateCadenceDays?: number
}

type FieldCheck = { ok: true } | { ok: false; reason: 'too_long' | 'invalid' }

function checkFields(fields: GoalFields): FieldCheck {
  if (fields.description !== undefined && fields.description.length > HOME_DESCRIPTION_MAX_CHARS)
    return { ok: false, reason: 'too_long' }
  if (fields.status !== undefined && !isStatus(fields.status))
    return { ok: false, reason: 'invalid' }
  if (
    fields.targetDate !== undefined &&
    fields.targetDate !== null &&
    (!Number.isFinite(fields.targetDate) || fields.targetDate < 0)
  )
    return { ok: false, reason: 'invalid' }
  if (
    fields.updateCadenceDays !== undefined &&
    (!Number.isInteger(fields.updateCadenceDays) ||
      fields.updateCadenceDays < 1 ||
      fields.updateCadenceDays > MAX_UPDATE_CADENCE_DAYS)
  )
    return { ok: false, reason: 'invalid' }
  if (fields.owner && !actorJson(fields.owner)) return { ok: false, reason: 'invalid' }
  return { ok: true }
}

/** The parent rule: same team, not archived, one level only, never itself. */
function checkParentTx(
  tx: BoardTx,
  teamId: string,
  goalId: string | null,
  parentGoalId: string,
): HomeResult<null> {
  if (goalId !== null && parentGoalId === goalId) return refuse('invalid_parent')
  const parent = goalRowTx(tx, teamId, parentGoalId)
  if (!parent || parent.archivedAt !== null) return refuse('invalid_parent')
  if (parent.parentGoalId !== null) return refuse('parent_has_parent')
  if (goalId !== null) {
    const child = tx
      .select({ id: teamGoals.id })
      .from(teamGoals)
      .where(and(eq(teamGoals.parentGoalId, goalId), isNull(teamGoals.archivedAt)))
      .get()
    if (child) return refuse('goal_has_children')
  }
  return done(null)
}

export function createTeamGoal(
  db: ClawbooDb,
  teamId: string,
  input: GoalFields & { title: string },
  actor: HomeActor | null,
): HomeResult<TeamGoalRecord> {
  const title = cleanTitle(input.title)
  if (!title.ok) return refuse(title.reason)
  const fields = checkFields(input)
  if (!fields.ok) return refuse(fields.reason)
  return immediateWrite(db, (tx): HomeResult<TeamGoalRecord> => {
    if (!teamExistsForHome(tx, teamId)) return refuse('team_not_found')
    const live = tx
      .select({ id: teamGoals.id, position: teamGoals.position })
      .from(teamGoals)
      .where(and(eq(teamGoals.teamId, teamId), isNull(teamGoals.archivedAt)))
      .all()
    if (live.length >= MAX_GOALS_PER_TEAM) return refuse('too_many')
    if (input.parentGoalId) {
      const parent = checkParentTx(tx, teamId, null, input.parentGoalId)
      if (!parent.ok) return parent
    }
    const now = Date.now()
    const row: DbTeamGoal = {
      id: randomUUID(),
      teamId,
      parentGoalId: input.parentGoalId ?? null,
      title: title.title,
      description: input.description ?? '',
      owner: actorJson(input.owner ?? null),
      targetDate: input.targetDate ?? null,
      status: input.status ?? 'active',
      health: null,
      healthSetBy: null,
      healthSetAt: null,
      updateCadenceDays: input.updateCadenceDays ?? 7,
      position: live.reduce((max, g) => Math.max(max, g.position + 1), 0),
      createdBy: actorJson(actor),
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
    }
    tx.insert(teamGoals).values(row).run()
    return done(toGoalRecord(row))
  })
}

export function updateTeamGoal(
  db: ClawbooDb,
  teamId: string,
  goalId: string,
  input: GoalFields,
): HomeResult<TeamGoalRecord> {
  let title: string | undefined
  if (input.title !== undefined) {
    const t = cleanTitle(input.title)
    if (!t.ok) return refuse(t.reason)
    title = t.title
  }
  const fields = checkFields(input)
  if (!fields.ok) return refuse(fields.reason)
  return immediateWrite(db, (tx): HomeResult<TeamGoalRecord> => {
    const row = goalRowTx(tx, teamId, goalId)
    if (!row) return refuse('goal_not_found')
    if (input.parentGoalId) {
      const parent = checkParentTx(tx, teamId, goalId, input.parentGoalId)
      if (!parent.ok) return parent
    }
    const patch: Partial<DbTeamGoal> = { updatedAt: Date.now() }
    if (title !== undefined) patch.title = title
    if (input.description !== undefined) patch.description = input.description
    if (input.parentGoalId !== undefined) patch.parentGoalId = input.parentGoalId
    if (input.owner !== undefined) patch.owner = actorJson(input.owner)
    if (input.targetDate !== undefined) patch.targetDate = input.targetDate
    if (input.status !== undefined) patch.status = input.status
    if (input.updateCadenceDays !== undefined) patch.updateCadenceDays = input.updateCadenceDays
    tx.update(teamGoals).set(patch).where(eq(teamGoals.id, goalId)).run()
    return done(toGoalRecord({ ...row, ...patch }))
  })
}

/** Archive a goal. Its tasks keep their link; its child goals lose their parent. */
export function archiveTeamGoal(
  db: ClawbooDb,
  teamId: string,
  goalId: string,
): HomeResult<TeamGoalRecord> {
  return immediateWrite(db, (tx): HomeResult<TeamGoalRecord> => {
    const row = goalRowTx(tx, teamId, goalId)
    if (!row) return refuse('goal_not_found')
    if (row.archivedAt !== null) return done(toGoalRecord(row))
    const now = Date.now()
    tx.update(teamGoals)
      .set({ archivedAt: now, updatedAt: now })
      .where(eq(teamGoals.id, goalId))
      .run()
    tx.update(teamGoals)
      .set({ parentGoalId: null, updatedAt: now })
      .where(eq(teamGoals.parentGoalId, goalId))
      .run()
    return done(toGoalRecord({ ...row, archivedAt: now, updatedAt: now }))
  })
}

/** Set a goal's health inside a write. Only a person's write calls it. */
export function setGoalHealthTx(
  tx: BoardTx,
  goalId: string,
  health: GoalHealth | null,
  actor: HomeActor | null,
  updateId: string | null,
  now: number,
): void {
  tx.update(teamGoals)
    .set({ health, healthSetBy: actorJson(actor), healthSetAt: now, updatedAt: now })
    .where(eq(teamGoals.id, goalId))
    .run()
  tx.insert(teamGoalHealth)
    .values({ id: randomUUID(), goalId, health, setBy: actorJson(actor), setAt: now, updateId })
    .run()
}

/** A person sets a goal's health directly; null clears it. */
export function setTeamGoalHealth(
  db: ClawbooDb,
  teamId: string,
  goalId: string,
  health: GoalHealth | null,
  actor: HomeActor | null,
): HomeResult<TeamGoalRecord> {
  if (health !== null && !isHealth(health)) return refuse('invalid')
  return immediateWrite(db, (tx): HomeResult<TeamGoalRecord> => {
    const row = goalRowTx(tx, teamId, goalId)
    if (!row) return refuse('goal_not_found')
    const now = Date.now()
    setGoalHealthTx(tx, goalId, health, actor, null, now)
    return done(
      toGoalRecord({
        ...row,
        health,
        healthSetBy: actorJson(actor),
        healthSetAt: now,
        updatedAt: now,
      }),
    )
  })
}

/** Put the named goals first, in this order; the rest keep their order after them. */
export function reorderTeamGoals(
  db: ClawbooDb,
  teamId: string,
  goalIds: readonly string[],
): HomeResult<TeamGoalRecord[]> {
  return immediateWrite(db, (tx): HomeResult<TeamGoalRecord[]> => {
    if (!teamExistsForHome(tx, teamId)) return refuse('team_not_found')
    const rows = tx
      .select()
      .from(teamGoals)
      .where(eq(teamGoals.teamId, teamId))
      .orderBy(asc(teamGoals.position), asc(teamGoals.createdAt))
      .all()
    const byId = new Map(rows.map((r) => [r.id, r]))
    const named = [...new Set(goalIds)].filter((id) => byId.has(id))
    const rest = rows.filter((r) => !named.includes(r.id)).map((r) => r.id)
    const now = Date.now()
    const ordered = [...named, ...rest]
    ordered.forEach((id, position) => {
      const row = byId.get(id)!
      if (row.position === position) return
      tx.update(teamGoals).set({ position, updatedAt: now }).where(eq(teamGoals.id, id)).run()
      byId.set(id, { ...row, position, updatedAt: now })
    })
    return done(
      ordered
        .map((id) => byId.get(id)!)
        .filter((r) => r.archivedAt === null)
        .map(toGoalRecord),
    )
  })
}

/** A goal's health changes, newest first. */
export function goalHealthHistory(db: ClawbooDb, goalId: string): GoalHealthChangeRecord[] {
  return db
    .select()
    .from(teamGoalHealth)
    .where(eq(teamGoalHealth.goalId, goalId))
    .orderBy(desc(teamGoalHealth.setAt))
    .limit(100)
    .all()
    .map((r) => ({
      health: isHealth(r.health) ? r.health : null,
      setBy: parseActor(r.setBy),
      setAt: r.setAt,
      updateId: r.updateId ?? null,
    }))
}
