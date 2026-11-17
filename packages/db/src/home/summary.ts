// A team's Home settings, and the status line its lead may write.
//
// The status line is computed from the board by default (metrics.ts). A person
// can turn on a written one per team: then the team's lead is asked for one in
// a short turn, and writes it with the Tasks tool `write_home_summary`. That
// costs model calls, so it is off until a person turns it on, and asks keep to
// limits that waste none:
//
// - The lead is asked only when the board moved past every point already seen: the
//   board's position when the line was turned on, at the last ask, and at the last
//   line. An untouched board is never asked about, before the first line too.
// - Asks and lines share one clock: at most one every 6 hours, counting both, and
//   at most 4 asks in a rolling day.
// - A line that answers the newest ask always lands, however soon after the last
//   line, so the model call it cost is never thrown away. A line the lead writes
//   unasked keeps to the same board and clock rules.
//
// The server never asks a lead that cannot hold the tool (an OpenClaw lead, or a
// Clawboo native lead whose Tasks access is read-only or off): see
// apps/web/server/lib/home/leadStatus.ts. An ask that fails to post is taken back.

import { eq, max } from 'drizzle-orm'

import { getSetting, setSetting, type ClawbooDb } from '../db'
import { withWriteRetry } from '../board/contention'
import { agents, tasks, teamHomeSummary } from '../schema'
import { actorJson, DAY_MS, HOME_SUMMARY_MAX_CHARS, parseActor, type HomeActor } from './types'

export const LEAD_STATUS_MIN_GAP_MS = 6 * 60 * 60 * 1000
export const LEAD_STATUS_MAX_PER_DAY = 4
/** A written line older than this gives way to the computed one. */
export const LEAD_STATUS_FRESH_MS = DAY_MS

export interface TeamHomeSettingsRecord {
  leadWritesStatus: boolean
  weeklyUpdatesRoutineId: string | null
}

interface StoredSettings extends TeamHomeSettingsRecord {
  /** When the lead was asked for a line, within the last day. */
  statusAsks: number[]
  /** When the lead wrote one, within the last day. */
  statusWrites: number[]
  /** The board's position when the line was last turned on. */
  onSeq: number
  /** The board's position at the newest ask. */
  lastAskSeq: number
  /** The newest ask, until a line answers it. */
  pendingAskAt: number | null
}

export function teamHomeSettingKey(teamId: string): string {
  return `team-home:${teamId}`
}

function readStored(db: ClawbooDb, teamId: string): StoredSettings {
  const fallback: StoredSettings = {
    leadWritesStatus: false,
    weeklyUpdatesRoutineId: null,
    statusAsks: [],
    statusWrites: [],
    onSeq: 0,
    lastAskSeq: 0,
    pendingAskAt: null,
  }
  const raw = getSetting(db, teamHomeSettingKey(teamId))
  if (!raw) return fallback
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>
    const times = (v: unknown): number[] =>
      Array.isArray(v)
        ? v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        : []
    const num = (v: unknown): number => (typeof v === 'number' && Number.isFinite(v) ? v : 0)
    return {
      leadWritesStatus: doc['leadWritesStatus'] === true,
      weeklyUpdatesRoutineId:
        typeof doc['weeklyUpdatesRoutineId'] === 'string' && doc['weeklyUpdatesRoutineId'] !== ''
          ? doc['weeklyUpdatesRoutineId']
          : null,
      statusAsks: times(doc['statusAsks']),
      statusWrites: times(doc['statusWrites']),
      onSeq: num(doc['onSeq']),
      lastAskSeq: num(doc['lastAskSeq']),
      pendingAskAt: typeof doc['pendingAskAt'] === 'number' ? doc['pendingAskAt'] : null,
    }
  } catch {
    return fallback
  }
}

function writeStored(db: ClawbooDb, teamId: string, value: StoredSettings, now: number): void {
  const recent = (list: number[]): number[] => list.filter((t) => now - t < DAY_MS).slice(-20)
  withWriteRetry(() =>
    setSetting(
      db,
      teamHomeSettingKey(teamId),
      JSON.stringify({
        ...value,
        statusAsks: recent(value.statusAsks),
        statusWrites: recent(value.statusWrites),
      }),
    ),
  )
}

export function getTeamHomeSettings(db: ClawbooDb, teamId: string): TeamHomeSettingsRecord {
  const s = readStored(db, teamId)
  return { leadWritesStatus: s.leadWritesStatus, weeklyUpdatesRoutineId: s.weeklyUpdatesRoutineId }
}

export function setTeamHomeSettings(
  db: ClawbooDb,
  teamId: string,
  patch: Partial<TeamHomeSettingsRecord>,
): TeamHomeSettingsRecord {
  const now = Date.now()
  const s = readStored(db, teamId)
  const turningOn = patch.leadWritesStatus === true && !s.leadWritesStatus
  const turningOff = patch.leadWritesStatus === false && s.leadWritesStatus
  const next: StoredSettings = {
    ...s,
    ...(patch.leadWritesStatus !== undefined ? { leadWritesStatus: patch.leadWritesStatus } : {}),
    ...(patch.weeklyUpdatesRoutineId !== undefined
      ? { weeklyUpdatesRoutineId: patch.weeklyUpdatesRoutineId }
      : {}),
    // The first ask waits for the board to move past where it stands now.
    ...(turningOn ? { onSeq: boardSeq(db, teamId), pendingAskAt: null } : {}),
    ...(turningOff ? { pendingAskAt: null } : {}),
  }
  writeStored(db, teamId, next, now)
  return {
    leadWritesStatus: next.leadWritesStatus,
    weeklyUpdatesRoutineId: next.weeklyUpdatesRoutineId,
  }
}

/** The team board's newest task change: what tells a status line it is behind. */
export function boardSeq(db: ClawbooDb, teamId: string): number {
  const row = db
    .select({ at: max(tasks.updatedAt) })
    .from(tasks)
    .where(eq(tasks.teamId, teamId))
    .get()
  return Number(row?.at ?? 0)
}

export interface HomeSummaryRecord {
  teamId: string
  body: string
  author: HomeActor | null
  executionId: string | null
  model: string | null
  writtenAt: number
  boardSeq: number
}

export function getHomeSummary(db: ClawbooDb, teamId: string): HomeSummaryRecord | null {
  const row = db.select().from(teamHomeSummary).where(eq(teamHomeSummary.teamId, teamId)).get()
  if (!row) return null
  return {
    teamId: row.teamId,
    body: row.body,
    author: parseActor(row.author),
    executionId: row.executionId ?? null,
    model: row.model ?? null,
    writtenAt: row.writtenAt,
    boardSeq: row.boardSeq,
  }
}

const lastOf = (list: readonly number[]): number => list.reduce((m, t) => Math.max(m, t), 0)

/** Did the board move past every point a line or an ask already saw? */
function boardMoved(s: StoredSettings, last: HomeSummaryRecord | null, seq: number): boolean {
  return seq > Math.max(s.onSeq, s.lastAskSeq, last?.boardSeq ?? 0)
}

/** Is it too soon after the last ask or line (one clock for both)? */
function tooSoon(s: StoredSettings, now: number): boolean {
  return now - Math.max(lastOf(s.statusAsks), lastOf(s.statusWrites)) < LEAD_STATUS_MIN_GAP_MS
}

const inLastDay = (list: readonly number[], now: number): number =>
  list.filter((t) => now - t < DAY_MS).length

/** Does a pending ask still stand? It lapses when the next ask could be made. */
function askStands(s: StoredSettings, now: number): boolean {
  return s.pendingAskAt !== null && now - s.pendingAskAt < LEAD_STATUS_MIN_GAP_MS
}

/** An ask that was recorded, with what it replaced, so it can be taken back. */
export interface LeadStatusAsk {
  teamId: string
  askedAt: number
  previousLastAskSeq: number
}

/**
 * Should the lead be asked for a status line now? Records the ask when it says
 * yes, so a second sweep in the same window says no; null when it says no.
 * `leadCanWrite`: whether the team's lead can hold `write_home_summary` at all (the
 * server knows; see above).
 */
export function takeLeadStatusAsk(
  db: ClawbooDb,
  teamId: string,
  now = Date.now(),
  opts: { leadCanWrite?: boolean } = {},
): LeadStatusAsk | null {
  if (opts.leadCanWrite === false) return null
  const s = readStored(db, teamId)
  if (!s.leadWritesStatus) return null
  const seq = boardSeq(db, teamId)
  if (!boardMoved(s, getHomeSummary(db, teamId), seq)) return null
  if (tooSoon(s, now)) return null
  if (inLastDay(s.statusAsks, now) >= LEAD_STATUS_MAX_PER_DAY) return null
  writeStored(
    db,
    teamId,
    { ...s, statusAsks: [...s.statusAsks, now], lastAskSeq: seq, pendingAskAt: now },
    now,
  )
  return { teamId, askedAt: now, previousLastAskSeq: s.lastAskSeq }
}

/**
 * Take back an ask that never reached the lead (posting it failed), so the next
 * pass may ask again instead of waiting out the clock and the board for an ask
 * nobody received. Leaves alone anything a later ask or line changed.
 */
export function withdrawLeadStatusAsk(db: ClawbooDb, ask: LeadStatusAsk): void {
  const s = readStored(db, ask.teamId)
  const at = s.statusAsks.lastIndexOf(ask.askedAt)
  if (at === -1) return
  const statusAsks = s.statusAsks.filter((_, i) => i !== at)
  const newest = statusAsks.every((t) => t < ask.askedAt)
  writeStored(
    db,
    ask.teamId,
    {
      ...s,
      statusAsks,
      ...(newest ? { lastAskSeq: ask.previousLastAskSeq } : {}),
      ...(s.pendingAskAt === ask.askedAt ? { pendingAskAt: null } : {}),
    },
    ask.askedAt,
  )
}

/** The model an agent is set to, as its registry row says, else its runtime. */
function agentModelLabel(db: ClawbooDb, agentId: string): string | null {
  const row = db
    .select({ runtime: agents.runtime, execConfig: agents.execConfig })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get()
  if (!row) return null
  try {
    const cfg = row.execConfig ? (JSON.parse(row.execConfig) as Record<string, unknown>) : {}
    for (const key of ['model', 'primaryModel']) {
      const v = cfg[key]
      if (typeof v === 'string' && v) return v
    }
  } catch {
    /* fall through to the runtime */
  }
  return row.runtime || null
}

export type WriteHomeSummaryResult =
  | { ok: true; value: HomeSummaryRecord }
  | {
      ok: false
      reason:
        'not_enabled' | 'not_lead' | 'unchanged' | 'too_soon' | 'too_many' | 'empty' | 'too_long'
    }

/**
 * The lead writes the team's status line. A line that answers the newest ask
 * lands; one written unasked keeps to the board and clock rules above.
 */
export function writeHomeSummary(
  db: ClawbooDb,
  input: {
    teamId: string
    agent: HomeActor
    isLead: boolean
    body: string
    executionId?: string | null
  },
  now = Date.now(),
): WriteHomeSummaryResult {
  if (!input.isLead) return { ok: false, reason: 'not_lead' }
  const body = typeof input.body === 'string' ? input.body.replace(/\s+/g, ' ').trim() : ''
  if (!body) return { ok: false, reason: 'empty' }
  if (body.length > HOME_SUMMARY_MAX_CHARS) return { ok: false, reason: 'too_long' }
  const s = readStored(db, input.teamId)
  if (!s.leadWritesStatus) return { ok: false, reason: 'not_enabled' }
  const seq = boardSeq(db, input.teamId)
  if (!askStands(s, now)) {
    if (!boardMoved(s, getHomeSummary(db, input.teamId), seq))
      return { ok: false, reason: 'unchanged' }
    if (tooSoon(s, now)) return { ok: false, reason: 'too_soon' }
    if (inLastDay(s.statusWrites, now) >= LEAD_STATUS_MAX_PER_DAY)
      return { ok: false, reason: 'too_many' }
  }
  const row = {
    teamId: input.teamId,
    body,
    author: actorJson(input.agent),
    executionId: input.executionId ?? null,
    model: agentModelLabel(db, input.agent.id),
    writtenAt: now,
    boardSeq: seq,
  }
  withWriteRetry(() =>
    db
      .insert(teamHomeSummary)
      .values(row)
      .onConflictDoUpdate({ target: teamHomeSummary.teamId, set: row })
      .run(),
  )
  writeStored(
    db,
    input.teamId,
    { ...s, statusWrites: [...s.statusWrites, now], pendingAskAt: null },
    now,
  )
  return { ok: true, value: { ...row, author: input.agent } }
}

/** The lead's line when the team turned it on and it is fresh, else null. */
export function freshLeadSummary(
  db: ClawbooDb,
  teamId: string,
  now = Date.now(),
): HomeSummaryRecord | null {
  const s = readStored(db, teamId)
  if (!s.leadWritesStatus) return null
  const summary = getHomeSummary(db, teamId)
  if (!summary || now - summary.writtenAt > LEAD_STATUS_FRESH_MS) return null
  return summary
}

/** Teams whose lead writes the status line. */
export function teamsWithLeadStatus(db: ClawbooDb, teamIds: readonly string[]): string[] {
  return teamIds.filter((id) => readStored(db, id).leadWritesStatus)
}
