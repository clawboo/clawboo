// A team's KPIs. A person defines each one once (name, unit, target, source).
// Values come from the board (`computed`, worked out on read), from an agent
// (`report_kpi`, with the run and task it came from) or from a person. An agent
// may suggest a KPI; only a person accepts it, and agents never change a
// definition or a target.

import { randomUUID } from 'node:crypto'

import { and, asc, desc, eq, gte, inArray, ne } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { immediateWrite, type BoardTx } from '../board/contention'
import { appendEvent } from '../events/appendEvent'
import {
  agents,
  teamGoals,
  teamKpis,
  teamKpiValues,
  type DbTeamKpi,
  type DbTeamKpiValue,
} from '../schema'
import { teamExistsForHome } from './goals'
import { computeMetric, periodStart, type TeamSnapshot } from './metrics'
import {
  actorJson,
  cleanTitle,
  DAY_MS,
  done,
  HOME_COMPUTED_METRICS,
  HOME_POINT_IN_TIME_METRICS,
  KPI_DIRECTIONS,
  KPI_NOTE_MAX_CHARS,
  KPI_PERIODS,
  KPI_SOURCES,
  KPI_STATUSES,
  KPI_UNIT_MAX_CHARS,
  MAX_KPI_VALUES_PER_DAY,
  MAX_KPIS_PER_TEAM,
  MAX_OPEN_KPI_SUGGESTIONS,
  parseActor,
  refuse,
  SOURCE_URL_MAX_CHARS,
  type HomeActor,
  type HomeComputedMetric,
  type HomeResult,
  type KpiDirection,
  type KpiPeriod,
  type KpiSource,
  type KpiStatus,
} from './types'

export interface TeamKpiRecord {
  id: string
  teamId: string
  goalId: string | null
  name: string
  unit: string
  direction: KpiDirection
  target: number | null
  period: KpiPeriod
  source: KpiSource
  metric: HomeComputedMetric | null
  reporterAgentId: string | null
  staleAfterHours: number | null
  status: KpiStatus
  suggestedBy: HomeActor | null
  suggestionNote: string | null
  createdBy: HomeActor | null
  position: number
  createdAt: number
  updatedAt: number
}

export interface KpiValueRecord {
  id: string
  kpiId: string
  value: number
  asOf: number
  reportedBy: HomeActor | null
  executionId: string | null
  taskId: string | null
  sourceUrl: string | null
  note: string | null
  createdAt: number
}

export interface KpiReadingRecord {
  value: number | null
  asOf: number | null
  source: KpiSource
  periodStart: number | null
  latest: KpiValueRecord | null
  freshness: 'ok' | 'stale' | 'missing'
}

export interface KpiTileRecord {
  kpi: TeamKpiRecord
  reading: KpiReadingRecord
}

const oneOf = <T extends string>(list: readonly T[], v: unknown): v is T =>
  typeof v === 'string' && (list as readonly string[]).includes(v)

export function toKpiRecord(row: DbTeamKpi): TeamKpiRecord {
  return {
    id: row.id,
    teamId: row.teamId,
    goalId: row.goalId ?? null,
    name: row.name,
    unit: row.unit,
    direction: oneOf(KPI_DIRECTIONS, row.direction) ? row.direction : 'up',
    target: row.target ?? null,
    period: oneOf(KPI_PERIODS, row.period) ? row.period : 'week',
    source: oneOf(KPI_SOURCES, row.source) ? row.source : 'person',
    metric: oneOf(HOME_COMPUTED_METRICS, row.metric) ? row.metric : null,
    reporterAgentId: row.reporterAgentId ?? null,
    staleAfterHours: row.staleAfterHours ?? null,
    status: oneOf(KPI_STATUSES, row.status) ? row.status : 'active',
    suggestedBy: parseActor(row.suggestedBy),
    suggestionNote: row.suggestionNote ?? null,
    createdBy: parseActor(row.createdBy),
    position: row.position,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  }
}

export function toValueRecord(row: DbTeamKpiValue): KpiValueRecord {
  return {
    id: row.id,
    kpiId: row.kpiId,
    value: row.value,
    asOf: row.asOf,
    reportedBy: parseActor(row.reportedBy),
    executionId: row.executionId ?? null,
    taskId: row.taskId ?? null,
    sourceUrl: row.sourceUrl ?? null,
    note: row.note ?? null,
    createdAt: row.createdAt,
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function listTeamKpis(
  db: ClawbooDb,
  teamId: string,
  opts: { statuses?: readonly KpiStatus[] } = {},
): TeamKpiRecord[] {
  const statuses = opts.statuses ?? ['active', 'suggested']
  return db
    .select()
    .from(teamKpis)
    .where(and(eq(teamKpis.teamId, teamId), inArray(teamKpis.status, [...statuses])))
    .orderBy(asc(teamKpis.position), asc(teamKpis.createdAt))
    .all()
    .map(toKpiRecord)
}

/** Suggestions waiting for a person, on these teams (all teams with none given). */
export function listSuggestedKpis(db: ClawbooDb, teamIds?: readonly string[]): TeamKpiRecord[] {
  if (teamIds !== undefined && teamIds.length === 0) return []
  const where =
    teamIds === undefined
      ? eq(teamKpis.status, 'suggested')
      : and(eq(teamKpis.status, 'suggested'), inArray(teamKpis.teamId, [...teamIds]))
  return db
    .select()
    .from(teamKpis)
    .where(where)
    .orderBy(desc(teamKpis.createdAt))
    .all()
    .map(toKpiRecord)
}

export function getTeamKpi(
  db: ClawbooDb | BoardTx,
  teamId: string,
  kpiId: string,
): TeamKpiRecord | null {
  const row = db
    .select()
    .from(teamKpis)
    .where(and(eq(teamKpis.id, kpiId), eq(teamKpis.teamId, teamId)))
    .get()
  return row ? toKpiRecord(row) : null
}

/** Stored values, newest first. */
export function listKpiValues(db: ClawbooDb, kpiId: string, limit = 100): KpiValueRecord[] {
  return db
    .select()
    .from(teamKpiValues)
    .where(eq(teamKpiValues.kpiId, kpiId))
    .orderBy(desc(teamKpiValues.asOf), desc(teamKpiValues.createdAt))
    .limit(Math.max(1, Math.min(limit, 1000)))
    .all()
    .map(toValueRecord)
}

function latestValues(db: ClawbooDb, kpiIds: readonly string[]): Map<string, KpiValueRecord> {
  const out = new Map<string, KpiValueRecord>()
  for (const id of kpiIds) {
    const row = db
      .select()
      .from(teamKpiValues)
      .where(eq(teamKpiValues.kpiId, id))
      .orderBy(desc(teamKpiValues.asOf), desc(teamKpiValues.createdAt))
      .limit(1)
      .get()
    if (row) out.set(id, toValueRecord(row))
  }
  return out
}

/** Each KPI with its current reading. `snap` is the KPI team's board, for computed ones. */
export function kpiTiles(
  db: ClawbooDb,
  kpis: readonly TeamKpiRecord[],
  snap: TeamSnapshot,
): KpiTileRecord[] {
  const stored = latestValues(
    db,
    kpis.filter((k) => k.source !== 'computed').map((k) => k.id),
  )
  return kpis.map((kpi) => ({ kpi, reading: readingOf(db, kpi, snap, stored.get(kpi.id) ?? null) }))
}

function readingOf(
  db: ClawbooDb,
  kpi: TeamKpiRecord,
  snap: TeamSnapshot,
  latest: KpiValueRecord | null,
): KpiReadingRecord {
  if (kpi.source === 'computed') {
    const value = kpi.metric ? computeMetric(db, snap, kpi.metric, kpi.period) : null
    const pointInTime = kpi.metric !== null && HOME_POINT_IN_TIME_METRICS.includes(kpi.metric)
    return {
      value,
      asOf: snap.now,
      source: 'computed',
      periodStart: pointInTime ? null : periodStart(kpi.period, snap.now),
      latest: null,
      freshness: 'ok',
    }
  }
  if (!latest)
    return {
      value: null,
      asOf: null,
      source: kpi.source,
      periodStart: null,
      latest: null,
      freshness: 'missing',
    }
  const stale =
    kpi.staleAfterHours !== null && snap.now - latest.asOf > kpi.staleAfterHours * 60 * 60 * 1000
  return {
    value: latest.value,
    asOf: latest.asOf,
    source: kpi.source,
    periodStart: null,
    latest,
    freshness: stale ? 'stale' : 'ok',
  }
}

// ─── A person's writes ───────────────────────────────────────────────────────

export interface KpiFields {
  name?: string
  unit?: string
  direction?: KpiDirection
  target?: number | null
  period?: KpiPeriod
  source?: KpiSource
  metric?: HomeComputedMetric | null
  goalId?: string | null
  reporterAgentId?: string | null
  staleAfterHours?: number | null
}

type Checked = HomeResult<Partial<DbTeamKpi>>

/** Validate fields and turn them into columns. `base` is the row being edited. */
function columnsFor(
  tx: BoardTx,
  teamId: string,
  fields: KpiFields,
  base: Partial<DbTeamKpi>,
): Checked {
  const patch: Partial<DbTeamKpi> = {}
  if (fields.name !== undefined) {
    const name = cleanTitle(fields.name)
    if (!name.ok) return refuse(name.reason)
    patch.name = name.title
  }
  if (fields.unit !== undefined) {
    if (typeof fields.unit !== 'string' || fields.unit.length > KPI_UNIT_MAX_CHARS)
      return refuse('invalid')
    patch.unit = fields.unit.trim()
  }
  if (fields.direction !== undefined) {
    if (!oneOf(KPI_DIRECTIONS, fields.direction)) return refuse('invalid')
    patch.direction = fields.direction
  }
  if (fields.target !== undefined) {
    if (fields.target !== null && !Number.isFinite(fields.target)) return refuse('invalid')
    patch.target = fields.target
  }
  if (fields.period !== undefined) {
    if (!oneOf(KPI_PERIODS, fields.period)) return refuse('invalid')
    patch.period = fields.period
  }
  if (fields.source !== undefined) {
    if (!oneOf(KPI_SOURCES, fields.source)) return refuse('invalid')
    patch.source = fields.source
  }
  if (fields.metric !== undefined) {
    if (fields.metric !== null && !oneOf(HOME_COMPUTED_METRICS, fields.metric))
      return refuse('invalid')
    patch.metric = fields.metric
  }
  if (fields.goalId !== undefined) {
    if (fields.goalId !== null) {
      const goal = tx
        .select({ teamId: teamGoals.teamId })
        .from(teamGoals)
        .where(eq(teamGoals.id, fields.goalId))
        .get()
      if (!goal || goal.teamId !== teamId) return refuse('goal_other_team')
    }
    patch.goalId = fields.goalId
  }
  if (fields.reporterAgentId !== undefined) {
    if (fields.reporterAgentId !== null) {
      const agent = tx
        .select({ teamId: agents.teamId })
        .from(agents)
        .where(eq(agents.id, fields.reporterAgentId))
        .get()
      if (!agent || agent.teamId !== teamId) return refuse('invalid')
    }
    patch.reporterAgentId = fields.reporterAgentId
  }
  if (fields.staleAfterHours !== undefined) {
    if (
      fields.staleAfterHours !== null &&
      (!Number.isFinite(fields.staleAfterHours) || fields.staleAfterHours <= 0)
    )
      return refuse('invalid')
    patch.staleAfterHours = fields.staleAfterHours
  }
  // The whole definition must hold together: a computed KPI names a metric, the
  // others do not.
  const source = patch.source ?? base.source
  const metric = patch.metric !== undefined ? patch.metric : (base.metric ?? null)
  if (source === 'computed' && !metric) return refuse('invalid')
  if (source !== 'computed') patch.metric = null
  if (source !== 'agent') patch.reporterAgentId = null
  if (source === 'computed') patch.staleAfterHours = null
  return done(patch)
}

function liveKpiCount(tx: BoardTx, teamId: string): number {
  return tx
    .select({ id: teamKpis.id })
    .from(teamKpis)
    .where(and(eq(teamKpis.teamId, teamId), ne(teamKpis.status, 'archived')))
    .all().length
}

function nextPosition(tx: BoardTx, teamId: string): number {
  const rows = tx
    .select({ position: teamKpis.position })
    .from(teamKpis)
    .where(eq(teamKpis.teamId, teamId))
    .all()
  return rows.reduce((max, r) => Math.max(max, r.position + 1), 0)
}

export function createTeamKpi(
  db: ClawbooDb,
  teamId: string,
  input: KpiFields & { name: string; source: KpiSource },
  person: HomeActor | null,
): HomeResult<TeamKpiRecord> {
  return immediateWrite(db, (tx): HomeResult<TeamKpiRecord> => {
    if (!teamExistsForHome(tx, teamId)) return refuse('team_not_found')
    if (liveKpiCount(tx, teamId) >= MAX_KPIS_PER_TEAM) return refuse('too_many')
    const cols = columnsFor(tx, teamId, input, {})
    if (!cols.ok) return cols
    const now = Date.now()
    const row: DbTeamKpi = {
      id: randomUUID(),
      teamId,
      goalId: null,
      name: '',
      unit: '',
      direction: 'up',
      target: null,
      period: 'week',
      source: input.source,
      metric: null,
      reporterAgentId: null,
      staleAfterHours: null,
      status: 'active',
      suggestedBy: null,
      suggestionNote: null,
      createdBy: actorJson(person),
      position: nextPosition(tx, teamId),
      createdAt: now,
      updatedAt: now,
      ...cols.value,
    }
    tx.insert(teamKpis).values(row).run()
    return done(toKpiRecord(row))
  })
}

export function updateTeamKpi(
  db: ClawbooDb,
  teamId: string,
  kpiId: string,
  input: KpiFields,
): HomeResult<TeamKpiRecord> {
  return immediateWrite(db, (tx): HomeResult<TeamKpiRecord> => {
    const row = tx
      .select()
      .from(teamKpis)
      .where(and(eq(teamKpis.id, kpiId), eq(teamKpis.teamId, teamId)))
      .get()
    if (!row) return refuse('kpi_not_found')
    if (row.status === 'archived') return refuse('archived')
    const cols = columnsFor(tx, teamId, input, row)
    if (!cols.ok) return cols
    const patch = { ...cols.value, updatedAt: Date.now() }
    tx.update(teamKpis).set(patch).where(eq(teamKpis.id, kpiId)).run()
    return done(toKpiRecord({ ...row, ...patch }))
  })
}

function setStatus(
  db: ClawbooDb,
  teamId: string,
  kpiId: string,
  to: KpiStatus,
  from: readonly KpiStatus[],
  refusal: 'not_suggested' | 'archived',
): HomeResult<TeamKpiRecord> {
  return immediateWrite(db, (tx): HomeResult<TeamKpiRecord> => {
    const row = tx
      .select()
      .from(teamKpis)
      .where(and(eq(teamKpis.id, kpiId), eq(teamKpis.teamId, teamId)))
      .get()
    if (!row) return refuse('kpi_not_found')
    if (row.status === to) return done(toKpiRecord(row))
    if (!(from as readonly string[]).includes(row.status)) return refuse(refusal)
    const patch = { status: to, updatedAt: Date.now() }
    tx.update(teamKpis).set(patch).where(eq(teamKpis.id, kpiId)).run()
    return done(toKpiRecord({ ...row, ...patch }))
  })
}

export function archiveTeamKpi(
  db: ClawbooDb,
  teamId: string,
  kpiId: string,
): HomeResult<TeamKpiRecord> {
  return setStatus(db, teamId, kpiId, 'archived', ['active', 'suggested'], 'archived')
}

/** A person dismisses a suggestion: it is archived, never active. */
export function dismissKpiSuggestion(
  db: ClawbooDb,
  teamId: string,
  kpiId: string,
): HomeResult<TeamKpiRecord> {
  return setStatus(db, teamId, kpiId, 'archived', ['suggested'], 'not_suggested')
}

/** A person accepts a suggestion, with their edits; it becomes active. */
export function acceptKpiSuggestion(
  db: ClawbooDb,
  teamId: string,
  kpiId: string,
  edits: KpiFields,
  person: HomeActor | null,
): HomeResult<TeamKpiRecord> {
  return immediateWrite(db, (tx): HomeResult<TeamKpiRecord> => {
    const row = tx
      .select()
      .from(teamKpis)
      .where(and(eq(teamKpis.id, kpiId), eq(teamKpis.teamId, teamId)))
      .get()
    if (!row) return refuse('kpi_not_found')
    if (row.status !== 'suggested') return refuse('not_suggested')
    if (liveKpiCount(tx, teamId) > MAX_KPIS_PER_TEAM) return refuse('too_many')
    const cols = columnsFor(tx, teamId, edits, row)
    if (!cols.ok) return cols
    const patch: Partial<DbTeamKpi> = {
      ...cols.value,
      status: 'active',
      createdBy: actorJson(person),
      updatedAt: Date.now(),
    }
    tx.update(teamKpis).set(patch).where(eq(teamKpis.id, kpiId)).run()
    return done(toKpiRecord({ ...row, ...patch }))
  })
}

// ─── Values ──────────────────────────────────────────────────────────────────

export interface KpiValueInput {
  value: number
  asOf?: number
  note?: string | null
  sourceUrl?: string | null
}

function cleanValue(
  input: KpiValueInput,
  now: number,
): HomeResult<{ asOf: number; note: string | null; sourceUrl: string | null }> {
  if (typeof input.value !== 'number' || !Number.isFinite(input.value)) return refuse('invalid')
  const asOf = input.asOf ?? now
  // A little room for a clock ahead of ours; nothing from the future beyond it.
  if (!Number.isFinite(asOf) || asOf < 0 || asOf > now + 5 * 60 * 1000) return refuse('invalid')
  const note = typeof input.note === 'string' ? input.note.trim() : ''
  if (note.length > KPI_NOTE_MAX_CHARS) return refuse('too_long')
  const sourceUrl = typeof input.sourceUrl === 'string' ? input.sourceUrl.trim() : ''
  if (sourceUrl.length > SOURCE_URL_MAX_CHARS) return refuse('too_long')
  if (sourceUrl && !/^https?:\/\//i.test(sourceUrl)) return refuse('invalid')
  return done({ asOf, note: note || null, sourceUrl: sourceUrl || null })
}

function insertValueTx(
  tx: BoardTx,
  kpi: DbTeamKpi,
  input: KpiValueInput,
  extra: { reportedBy: HomeActor | null; executionId: string | null; taskId: string | null },
): HomeResult<KpiValueRecord> {
  const now = Date.now()
  const clean = cleanValue(input, now)
  if (!clean.ok) return clean
  const recent = tx
    .select({ id: teamKpiValues.id })
    .from(teamKpiValues)
    .where(and(eq(teamKpiValues.kpiId, kpi.id), gte(teamKpiValues.createdAt, now - DAY_MS)))
    .all().length
  if (recent >= MAX_KPI_VALUES_PER_DAY) return refuse('too_many')
  const row: DbTeamKpiValue = {
    id: randomUUID(),
    kpiId: kpi.id,
    value: input.value,
    asOf: clean.value.asOf,
    reportedBy: actorJson(extra.reportedBy),
    executionId: extra.executionId,
    taskId: extra.taskId,
    sourceUrl: clean.value.sourceUrl,
    note: clean.value.note,
    createdAt: now,
  }
  tx.insert(teamKpiValues).values(row).run()
  return done(toValueRecord(row))
}

/** A person types a value: only for an active KPI whose source is `person`. */
export function addPersonKpiValue(
  db: ClawbooDb,
  teamId: string,
  kpiId: string,
  input: KpiValueInput,
  person: HomeActor | null,
): HomeResult<KpiValueRecord> {
  return immediateWrite(db, (tx): HomeResult<KpiValueRecord> => {
    const kpi = tx
      .select()
      .from(teamKpis)
      .where(and(eq(teamKpis.id, kpiId), eq(teamKpis.teamId, teamId)))
      .get()
    if (!kpi) return refuse('kpi_not_found')
    if (kpi.status !== 'active') return refuse('not_active')
    if (kpi.source !== 'person') return refuse('wrong_source')
    return insertValueTx(tx, kpi, input, { reportedBy: person, executionId: null, taskId: null })
  })
}

export interface AgentKpiReport extends KpiValueInput {
  kpiId: string
  /** The reporting agent's own team: a KPI of another team is not found. */
  teamId: string
  agent: HomeActor
  executionId?: string | null
  taskId?: string | null
}

/**
 * An agent reports a value: only an active KPI whose source is `agent`, on the
 * agent's own team, and only by its named reporter when it has one.
 */
export function reportAgentKpiValue(
  db: ClawbooDb,
  input: AgentKpiReport,
): HomeResult<KpiValueRecord> {
  const result = immediateWrite(db, (tx): HomeResult<KpiValueRecord> => {
    const kpi = tx
      .select()
      .from(teamKpis)
      .where(and(eq(teamKpis.id, input.kpiId), eq(teamKpis.teamId, input.teamId)))
      .get()
    if (!kpi) return refuse('kpi_not_found')
    if (kpi.status !== 'active') return refuse('not_active')
    if (kpi.source !== 'agent') return refuse('wrong_source')
    if (kpi.reporterAgentId && kpi.reporterAgentId !== input.agent.id) return refuse('not_reporter')
    return insertValueTx(tx, kpi, input, {
      reportedBy: input.agent,
      executionId: input.executionId ?? null,
      taskId: input.taskId ?? null,
    })
  })
  if (result.ok) {
    try {
      appendEvent(db, {
        kind: 'kpi_reported',
        teamId: input.teamId,
        taskId: input.taskId ?? null,
        agentId: input.agent.id,
        data: {
          kpiId: input.kpiId,
          value: result.value.value,
          asOf: result.value.asOf,
          executionId: input.executionId ?? null,
          actor: input.agent,
        },
      })
    } catch {
      // Best effort: the value is stored.
    }
  }
  return result
}

export interface KpiSuggestion {
  teamId: string
  name: string
  unit?: string
  direction?: KpiDirection
  target?: number | null
  goalId?: string | null
  why: string
  agent: HomeActor
}

/** An agent suggests a KPI. It waits, `suggested`, until a person accepts or dismisses it. */
export function suggestTeamKpi(db: ClawbooDb, input: KpiSuggestion): HomeResult<TeamKpiRecord> {
  const why = typeof input.why === 'string' ? input.why.trim() : ''
  if (!why) return refuse('empty')
  if (why.length > KPI_NOTE_MAX_CHARS) return refuse('too_long')
  return immediateWrite(db, (tx): HomeResult<TeamKpiRecord> => {
    if (!teamExistsForHome(tx, input.teamId)) return refuse('team_not_found')
    const open = tx
      .select({ id: teamKpis.id })
      .from(teamKpis)
      .where(and(eq(teamKpis.teamId, input.teamId), eq(teamKpis.status, 'suggested')))
      .all().length
    if (open >= MAX_OPEN_KPI_SUGGESTIONS) return refuse('too_many')
    if (liveKpiCount(tx, input.teamId) >= MAX_KPIS_PER_TEAM) return refuse('too_many')
    // A suggestion's source is a person's until someone decides otherwise on accept.
    const cols = columnsFor(
      tx,
      input.teamId,
      {
        name: input.name,
        ...(input.unit !== undefined ? { unit: input.unit } : {}),
        ...(input.direction !== undefined ? { direction: input.direction } : {}),
        ...(input.target !== undefined ? { target: input.target } : {}),
        ...(input.goalId !== undefined ? { goalId: input.goalId } : {}),
        source: 'person',
      },
      {},
    )
    if (!cols.ok) return cols
    const now = Date.now()
    const row: DbTeamKpi = {
      id: randomUUID(),
      teamId: input.teamId,
      goalId: null,
      name: '',
      unit: '',
      direction: 'up',
      target: null,
      period: 'week',
      source: 'person',
      metric: null,
      reporterAgentId: null,
      staleAfterHours: null,
      status: 'suggested',
      suggestedBy: actorJson(input.agent),
      suggestionNote: why,
      createdBy: null,
      position: nextPosition(tx, input.teamId),
      createdAt: now,
      updatedAt: now,
      ...cols.value,
    }
    tx.insert(teamKpis).values(row).run()
    return done(toKpiRecord(row))
  })
}
