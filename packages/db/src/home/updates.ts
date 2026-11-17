// Status updates on a goal. An agent drafts one (the Tasks tool
// `draft_goal_update`); only a person publishes or discards it, or writes one of
// their own, which is published at once. Publishing an update that names a health
// sets the goal's health: that, and a person's direct set, are the only ways a
// goal's health changes.

import { randomUUID } from 'node:crypto'

import { and, desc, eq, inArray } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { immediateWrite, type BoardTx } from '../board/contention'
import { appendEvent } from '../events/appendEvent'
import { teamGoals, teamGoalUpdates, type DbTeamGoal, type DbTeamGoalUpdate } from '../schema'
import { setGoalHealthTx, toGoalRecord, type TeamGoalRecord } from './goals'
import {
  actorJson,
  done,
  GOAL_HEALTHS,
  GOAL_UPDATE_MAX_CHARS,
  GOAL_UPDATE_STATES,
  MAX_OPEN_DRAFTS_PER_GOAL,
  parseActor,
  refuse,
  type GoalHealth,
  type GoalUpdateState,
  type HomeActor,
  type HomeResult,
} from './types'

export interface GoalUpdateRecord {
  id: string
  goalId: string
  teamId: string
  body: string
  health: GoalHealth | null
  author: HomeActor | null
  executionId: string | null
  state: GoalUpdateState
  publishedBy: HomeActor | null
  publishedAt: number | null
  createdAt: number
}

const isHealth = (v: unknown): v is GoalHealth =>
  typeof v === 'string' && (GOAL_HEALTHS as readonly string[]).includes(v)

export function toUpdateRecord(row: DbTeamGoalUpdate): GoalUpdateRecord {
  return {
    id: row.id,
    goalId: row.goalId,
    teamId: row.teamId,
    body: row.body,
    health: isHealth(row.health) ? row.health : null,
    author: parseActor(row.author),
    executionId: row.executionId ?? null,
    state: (GOAL_UPDATE_STATES as readonly string[]).includes(row.state)
      ? (row.state as GoalUpdateState)
      : 'draft',
    publishedBy: parseActor(row.publishedBy),
    publishedAt: row.publishedAt ?? null,
    createdAt: row.createdAt,
  }
}

function cleanBody(
  raw: unknown,
): { ok: true; body: string } | { ok: false; reason: 'empty' | 'too_long' } {
  const body = typeof raw === 'string' ? raw.trim() : ''
  if (!body) return { ok: false, reason: 'empty' }
  if (body.length > GOAL_UPDATE_MAX_CHARS) return { ok: false, reason: 'too_long' }
  return { ok: true, body }
}

function emit(
  db: ClawbooDb,
  kind: 'goal_update_drafted' | 'goal_update_published',
  update: GoalUpdateRecord,
  actor: HomeActor | null,
): void {
  try {
    appendEvent(db, {
      kind,
      teamId: update.teamId,
      agentId: actor?.kind === 'agent' ? actor.id : null,
      data: {
        goalId: update.goalId,
        updateId: update.id,
        health: update.health,
        executionId: update.executionId,
        actor,
      },
    })
  } catch {
    // The log is best effort; the update stands.
  }
}

/** A goal's updates, newest first. */
export function listGoalUpdates(db: ClawbooDb, goalId: string, limit = 100): GoalUpdateRecord[] {
  return db
    .select()
    .from(teamGoalUpdates)
    .where(eq(teamGoalUpdates.goalId, goalId))
    .orderBy(desc(teamGoalUpdates.createdAt))
    .limit(limit)
    .all()
    .map(toUpdateRecord)
}

/** Drafts waiting for a person, on these teams (all teams with none given). */
export function listDraftUpdates(db: ClawbooDb, teamIds?: readonly string[]): GoalUpdateRecord[] {
  const where =
    teamIds === undefined
      ? eq(teamGoalUpdates.state, 'draft')
      : and(eq(teamGoalUpdates.state, 'draft'), inArray(teamGoalUpdates.teamId, [...teamIds]))
  if (teamIds !== undefined && teamIds.length === 0) return []
  return db
    .select()
    .from(teamGoalUpdates)
    .where(where)
    .orderBy(desc(teamGoalUpdates.createdAt))
    .all()
    .map(toUpdateRecord)
}

/** goal id -> the newest published update's time. */
export function lastPublishedByGoal(
  db: ClawbooDb,
  goalIds: readonly string[],
): Map<string, number> {
  const out = new Map<string, number>()
  if (goalIds.length === 0) return out
  const rows = db
    .select({ goalId: teamGoalUpdates.goalId, publishedAt: teamGoalUpdates.publishedAt })
    .from(teamGoalUpdates)
    .where(
      and(eq(teamGoalUpdates.state, 'published'), inArray(teamGoalUpdates.goalId, [...goalIds])),
    )
    .all()
  for (const r of rows) {
    if (r.publishedAt === null) continue
    out.set(r.goalId, Math.max(out.get(r.goalId) ?? 0, r.publishedAt))
  }
  return out
}

export interface DraftGoalUpdateInput {
  goalId: string
  /** The agent's own team: a goal of another team is not found. */
  teamId: string
  body: string
  health?: GoalHealth | null
  agent: HomeActor
  executionId?: string | null
}

/**
 * An agent's draft. Never published here. The same agent's earlier draft on the
 * same goal is discarded, so a weekly routine that runs twice leaves one draft.
 */
export function draftGoalUpdate(
  db: ClawbooDb,
  input: DraftGoalUpdateInput,
): HomeResult<GoalUpdateRecord> {
  const body = cleanBody(input.body)
  if (!body.ok) return refuse(body.reason)
  if (input.health !== undefined && input.health !== null && !isHealth(input.health))
    return refuse('invalid')
  const result = immediateWrite(db, (tx): HomeResult<GoalUpdateRecord> => {
    const goal = tx
      .select()
      .from(teamGoals)
      .where(and(eq(teamGoals.id, input.goalId), eq(teamGoals.teamId, input.teamId)))
      .get()
    if (!goal) return refuse('goal_not_found')
    if (goal.archivedAt !== null) return refuse('goal_archived')
    const drafts = tx
      .select({ id: teamGoalUpdates.id, author: teamGoalUpdates.author })
      .from(teamGoalUpdates)
      .where(and(eq(teamGoalUpdates.goalId, goal.id), eq(teamGoalUpdates.state, 'draft')))
      .all()
    const mine = drafts.filter((d) => {
      const a = parseActor(d.author)
      return a?.kind === 'agent' && a.id === input.agent.id
    })
    if (drafts.length - mine.length >= MAX_OPEN_DRAFTS_PER_GOAL) return refuse('too_many')
    if (mine.length > 0)
      tx.update(teamGoalUpdates)
        .set({ state: 'discarded' })
        .where(
          inArray(
            teamGoalUpdates.id,
            mine.map((d) => d.id),
          ),
        )
        .run()
    const row: DbTeamGoalUpdate = {
      id: randomUUID(),
      goalId: goal.id,
      teamId: goal.teamId,
      body: body.body,
      health: input.health ?? null,
      author: actorJson(input.agent),
      executionId: input.executionId ?? null,
      state: 'draft',
      publishedBy: null,
      publishedAt: null,
      createdAt: Date.now(),
    }
    tx.insert(teamGoalUpdates).values(row).run()
    return done(toUpdateRecord(row))
  })
  if (result.ok) emit(db, 'goal_update_drafted', result.value, input.agent)
  return result
}

function publishTx(
  tx: BoardTx,
  goal: DbTeamGoal,
  row: DbTeamGoalUpdate,
  person: HomeActor | null,
  now: number,
): { update: GoalUpdateRecord; goal: TeamGoalRecord } {
  tx.update(teamGoalUpdates)
    .set({
      body: row.body,
      health: row.health,
      state: 'published',
      publishedBy: actorJson(person),
      publishedAt: now,
    })
    .where(eq(teamGoalUpdates.id, row.id))
    .run()
  let goalRow: DbTeamGoal = goal
  if (isHealth(row.health)) {
    setGoalHealthTx(tx, goal.id, row.health, person, row.id, now)
    goalRow = {
      ...goal,
      health: row.health,
      healthSetBy: actorJson(person),
      healthSetAt: now,
      updatedAt: now,
    }
  }
  return {
    update: toUpdateRecord({
      ...row,
      state: 'published',
      publishedBy: actorJson(person),
      publishedAt: now,
    }),
    goal: toGoalRecord(goalRow),
  }
}

/** A person writes an update; it is published at once. */
export function createPublishedUpdate(
  db: ClawbooDb,
  teamId: string,
  goalId: string,
  input: { body: string; health?: GoalHealth | null },
  person: HomeActor | null,
): HomeResult<{ update: GoalUpdateRecord; goal: TeamGoalRecord }> {
  const body = cleanBody(input.body)
  if (!body.ok) return refuse(body.reason)
  if (input.health !== undefined && input.health !== null && !isHealth(input.health))
    return refuse('invalid')
  const result = immediateWrite(
    db,
    (tx): HomeResult<{ update: GoalUpdateRecord; goal: TeamGoalRecord }> => {
      const goal = tx
        .select()
        .from(teamGoals)
        .where(and(eq(teamGoals.id, goalId), eq(teamGoals.teamId, teamId)))
        .get()
      if (!goal) return refuse('goal_not_found')
      const now = Date.now()
      const row: DbTeamGoalUpdate = {
        id: randomUUID(),
        goalId,
        teamId,
        body: body.body,
        health: input.health ?? null,
        author: actorJson(person),
        executionId: null,
        state: 'draft',
        publishedBy: null,
        publishedAt: null,
        createdAt: now,
      }
      tx.insert(teamGoalUpdates).values(row).run()
      return done(publishTx(tx, goal, row, person, now))
    },
  )
  if (result.ok) emit(db, 'goal_update_published', result.value.update, person)
  return result
}

/** Publish a draft, edited first when the person changed its words or health. */
export function publishGoalUpdate(
  db: ClawbooDb,
  teamId: string,
  updateId: string,
  edits: { body?: string; health?: GoalHealth | null },
  person: HomeActor | null,
): HomeResult<{ update: GoalUpdateRecord; goal: TeamGoalRecord }> {
  let body: string | undefined
  if (edits.body !== undefined) {
    const cleaned = cleanBody(edits.body)
    if (!cleaned.ok) return refuse(cleaned.reason)
    body = cleaned.body
  }
  if (edits.health !== undefined && edits.health !== null && !isHealth(edits.health))
    return refuse('invalid')
  const result = immediateWrite(
    db,
    (tx): HomeResult<{ update: GoalUpdateRecord; goal: TeamGoalRecord }> => {
      const row = tx
        .select()
        .from(teamGoalUpdates)
        .where(and(eq(teamGoalUpdates.id, updateId), eq(teamGoalUpdates.teamId, teamId)))
        .get()
      if (!row) return refuse('update_not_found')
      if (row.state !== 'draft') return refuse('not_draft')
      const goal = tx.select().from(teamGoals).where(eq(teamGoals.id, row.goalId)).get()
      if (!goal) return refuse('goal_not_found')
      const edited: DbTeamGoalUpdate = {
        ...row,
        ...(body !== undefined ? { body } : {}),
        ...(edits.health !== undefined ? { health: edits.health } : {}),
      }
      return done(publishTx(tx, goal, edited, person, Date.now()))
    },
  )
  if (result.ok) emit(db, 'goal_update_published', result.value.update, person)
  return result
}

export function discardGoalUpdate(
  db: ClawbooDb,
  teamId: string,
  updateId: string,
): HomeResult<GoalUpdateRecord> {
  return immediateWrite(db, (tx): HomeResult<GoalUpdateRecord> => {
    const row = tx
      .select()
      .from(teamGoalUpdates)
      .where(and(eq(teamGoalUpdates.id, updateId), eq(teamGoalUpdates.teamId, teamId)))
      .get()
    if (!row) return refuse('update_not_found')
    if (row.state !== 'draft') return refuse('not_draft')
    tx.update(teamGoalUpdates)
      .set({ state: 'discarded' })
      .where(eq(teamGoalUpdates.id, updateId))
      .run()
    return done(toUpdateRecord({ ...row, state: 'discarded' }))
  })
}
