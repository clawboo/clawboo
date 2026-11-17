// A team's Home settings, and the status line its lead may write.
//
// The status line is computed from the board by default (metrics.ts). A person
// can turn on a written one per team: then the team's lead is asked for one in
// a short turn, and writes it with the Tasks tool `write_home_summary`. That
// costs model calls, so it is off until a person turns it on, and both the asks
// and the writes keep to the same limits: only when the board changed since the
// last line, at most once every 6 hours, and at most 4 times in a rolling day.

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
  /** When the lead was last asked for a line, within the last day. */
  statusAsks: number[]
  /** When the lead last wrote one, within the last day. */
  statusWrites: number[]
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
  }
  const raw = getSetting(db, teamHomeSettingKey(teamId))
  if (!raw) return fallback
  try {
    const doc = JSON.parse(raw) as Record<string, unknown>
    const times = (v: unknown): number[] =>
      Array.isArray(v)
        ? v.filter((n): n is number => typeof n === 'number' && Number.isFinite(n))
        : []
    return {
      leadWritesStatus: doc['leadWritesStatus'] === true,
      weeklyUpdatesRoutineId:
        typeof doc['weeklyUpdatesRoutineId'] === 'string' && doc['weeklyUpdatesRoutineId'] !== ''
          ? doc['weeklyUpdatesRoutineId']
          : null,
      statusAsks: times(doc['statusAsks']),
      statusWrites: times(doc['statusWrites']),
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
  const next: StoredSettings = {
    ...s,
    ...(patch.leadWritesStatus !== undefined ? { leadWritesStatus: patch.leadWritesStatus } : {}),
    ...(patch.weeklyUpdatesRoutineId !== undefined
      ? { weeklyUpdatesRoutineId: patch.weeklyUpdatesRoutineId }
      : {}),
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

type Gate =
  { ok: true } | { ok: false; reason: 'not_enabled' | 'unchanged' | 'too_soon' | 'too_many' }

function gate(
  s: StoredSettings,
  times: number[],
  last: HomeSummaryRecord | null,
  seq: number,
  now: number,
): Gate {
  if (!s.leadWritesStatus) return { ok: false, reason: 'not_enabled' }
  if (last && seq <= last.boardSeq) return { ok: false, reason: 'unchanged' }
  const recent = times.filter((t) => now - t < DAY_MS)
  if (recent.some((t) => now - t < LEAD_STATUS_MIN_GAP_MS)) return { ok: false, reason: 'too_soon' }
  if (recent.length >= LEAD_STATUS_MAX_PER_DAY) return { ok: false, reason: 'too_many' }
  return { ok: true }
}

/**
 * Should the lead be asked for a status line now? Records the ask when it says
 * yes, so a second sweep in the same window says no.
 */
export function takeLeadStatusAsk(db: ClawbooDb, teamId: string, now = Date.now()): boolean {
  const s = readStored(db, teamId)
  const verdict = gate(s, s.statusAsks, getHomeSummary(db, teamId), boardSeq(db, teamId), now)
  if (!verdict.ok) return false
  writeStored(db, teamId, { ...s, statusAsks: [...s.statusAsks, now] }, now)
  return true
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

/** The lead writes the team's status line, inside the limits above. */
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
  const seq = boardSeq(db, input.teamId)
  const verdict = gate(s, s.statusWrites, getHomeSummary(db, input.teamId), seq, now)
  if (!verdict.ok) return verdict
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
  writeStored(db, input.teamId, { ...s, statusWrites: [...s.statusWrites, now] }, now)
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
