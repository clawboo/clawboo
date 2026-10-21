// Pure display and form helpers for the Routines view, kept out of the React
// components so they are unit-testable in the node test project.

import {
  decodeCronSpec,
  isOnceSpec,
  nextOccurrence,
  ONCE_PREFIX,
  probeCronSpec,
  type ScheduleCreateSpec,
  type ScheduleRecord,
  type ScheduleUpdatePatch,
} from '@clawboo/scheduler'

import type { StatusTone } from '@/features/shared/StatusPill'

import { RUNTIME_CATALOG, type RuntimeId } from '../runtimes/runtimeCatalog'

/**
 * Cron-EXPRESSION presets. A cron expression is the one spec dialect both
 * schedule sources accept: routines parse it with croner, and the Gateway source
 * decodes an unprefixed spec as a cron expression.
 */
export const CRON_PRESETS: readonly { label: string; cron: string }[] = [
  { label: 'Every 5 minutes', cron: '*/5 * * * *' },
  { label: 'Every 15 minutes', cron: '*/15 * * * *' },
  { label: 'Every 30 minutes', cron: '*/30 * * * *' },
  { label: 'Every hour', cron: '0 * * * *' },
  { label: 'Every 6 hours', cron: '0 */6 * * *' },
  { label: 'Every 12 hours', cron: '0 */12 * * *' },
  { label: 'Daily · 9am', cron: '0 9 * * *' },
  { label: 'Weekdays · 9am', cron: '0 9 * * 1-5' },
  { label: 'Weekly · Mon 9am', cron: '0 9 * * 1' },
]

/** The preset a new routine starts on (hourly). */
export const DEFAULT_CRON = '0 * * * *'

const PRESET_LABEL = new Map(CRON_PRESETS.map((p) => [p.cron, p.label]))

export function isCronPreset(spec: string): boolean {
  return PRESET_LABEL.has(spec.trim())
}

/**
 * Human-friendly label for a schedule's cron spec. Handles BOTH source dialects:
 * the Gateway `every:`/`at:`/cron forms (via decodeCronSpec) and the routine
 * one-shot `once@<ISO>`. The one-shot is checked FIRST because decodeCronSpec
 * would otherwise treat `once@…` as a raw (ugly) cron expression.
 */
export function formatScheduleLabel(spec: string): string {
  if (isOnceSpec(spec)) {
    const iso = spec.trim().slice(ONCE_PREFIX.length)
    return Number.isNaN(Date.parse(iso)) ? spec : `once · ${iso}`
  }
  const s = decodeCronSpec(spec)
  if (s.kind === 'every') {
    const ms = s.everyMs
    if (ms % 86_400_000 === 0) return `every ${ms / 86_400_000}d`
    if (ms % 3_600_000 === 0) return `every ${ms / 3_600_000}h`
    if (ms % 60_000 === 0) return `every ${ms / 60_000}m`
    return `every ${Math.round(ms / 1000)}s`
  }
  if (s.kind === 'at') return `once · ${s.at}`
  return s.expr
}

/** A preset's name, else the compact form of the spec. */
export function humanCron(spec: string): string {
  return PRESET_LABEL.get(spec.trim()) ?? formatScheduleLabel(spec)
}

/** Why a typed cron expression cannot be used, or null when it can. */
export function cronError(spec: string): string | null {
  const trimmed = spec.trim()
  if (!trimmed) return 'Enter a cron expression, for example 30 8 * * 1-5.'
  try {
    probeCronSpec(trimmed)
    if (nextOccurrence(trimmed, Date.now()) == null) return 'This schedule never runs again.'
    return null
  } catch {
    return 'That is not a cron expression this can read.'
  }
}

/** When a spec fires next after `now`, or null (invalid, or never again). */
export function nextRunPreview(spec: string, now = Date.now()): number | null {
  try {
    return nextOccurrence(spec.trim(), now)
  } catch {
    return null
  }
}

export function untilLabel(ms: number, now = Date.now()): string {
  const diff = ms - now
  if (diff <= 0) return 'due now'
  const sec = Math.floor(diff / 1000)
  if (sec < 60) return `in ${sec}s`
  const m = Math.floor(sec / 60)
  if (m < 60) return `in ${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return `in ${h}h`
  return `in ${Math.floor(h / 24)}d`
}

/** A timestamp as the person's local weekday, date and time. */
export function formatWhen(ms: number): string {
  return new Date(ms).toLocaleString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  })
}

/**
 * The status pill for a row. An idle routine is ON (armed for its next run)
 * unless it has no next run at all, which is a spent one-shot. A routine parks
 * in `error` after a failed run and does not run again until it is resumed; a
 * Gateway job in `error` only failed its last run and stays enabled.
 */
export function statusPill(rec: Pick<ScheduleRecord, 'status' | 'nextRunAt' | 'manageability'>): {
  tone: StatusTone
  label: string
} {
  switch (rec.status) {
    case 'running':
      return { tone: 'working', label: 'running' }
    case 'queued':
      return { tone: 'working', label: 'queued' }
    case 'claimed':
      return { tone: 'working', label: 'starting' }
    case 'paused':
      return { tone: 'idle', label: rec.manageability === 'external-write' ? 'disabled' : 'paused' }
    case 'error':
      return { tone: 'error', label: 'failed' }
    default:
      return rec.nextRunAt == null
        ? { tone: 'done', label: 'finished' }
        : { tone: 'success', label: 'on' }
  }
}

/** A routine's name when the person gave none: the first line of what it does. */
export function deriveRoutineName(instructions: string): string {
  const firstLine =
    instructions
      .split('\n')
      .map((l) => l.trim())
      .find(Boolean) ?? ''
  if (firstLine.length <= 60) return firstLine
  return `${firstLine.slice(0, 57).trimEnd()}...`
}

/** Routine rows target a team or one agent; Gateway rows always target one agent. */
export function routineKindOf(rec: Pick<ScheduleRecord, 'target'>): 'team' | 'agent' {
  return rec.target === 'team' ? 'team' : 'agent'
}

/**
 * One line naming where a routine's fires go. A team routine goes to the team's
 * chat, where its lead picks it up; an agent routine is a task for one agent.
 * Names are resolved when the list is read, so a missing one is a team or agent
 * that was deleted after the routine was made.
 */
export function targetSummary(
  rec: Pick<ScheduleRecord, 'target' | 'teamName' | 'agentName' | 'agentId'>,
): string {
  if (routineKindOf(rec) === 'team') {
    if (!rec.teamName) return 'Team not found'
    return rec.agentName
      ? `${rec.teamName} team chat · ${rec.agentName} leads`
      : `${rec.teamName} team chat`
  }
  const agent = rec.agentName ?? 'Agent not found'
  return rec.teamName ? `${agent} · ${rec.teamName}` : agent
}

/**
 * Why a routine cannot be paused or resumed right now, or null when it can. A
 * fire in flight settles on its own, and the ledger refuses a pause or resume
 * under it. A Gateway job can be enabled or disabled at any time.
 */
export function toggleBlocker(
  rec: Pick<ScheduleRecord, 'status' | 'manageability'>,
): string | null {
  if (rec.manageability === 'external-write') return null
  return rec.status === 'claimed' || rec.status === 'running' ? 'it is running now' : null
}

/** Why Run now is unavailable, or null when it is. A Gateway job can always run. */
export function runNowBlocker(
  rec: Pick<ScheduleRecord, 'status' | 'manageability'>,
): string | null {
  if (rec.manageability === 'external-write' || rec.status === 'idle') return null
  if (rec.status === 'paused' || rec.status === 'error') return 'resume it first'
  return rec.status === 'queued' ? 'it is about to run' : 'it is running now'
}

/** The composite-id prefix of clawboo's own routines (the managed source). */
export function isClawbooRoutine(rec: Pick<ScheduleRecord, 'source'>): boolean {
  return rec.source === 'clawboo-routine'
}

// ─── The create / edit form ──────────────────────────────────────────────────

/** The team picker's value for agents that are on no team. */
export const NO_TEAM = '__no-team__'

export interface RoutineDirectoryTeam {
  id: string
  name: string
  icon: string
}

export interface RoutineDirectoryAgent {
  id: string
  name: string
  runtime: string
  teamId: string | null
}

export interface RoutineFormValues {
  kind: 'team' | 'agent'
  /** A team id, NO_TEAM (an agent that is on no team), or '' (nothing chosen). */
  teamId: string
  agentId: string
  name: string
  instructions: string
  cron: string
}

const byName = <T extends { name: string }>(a: T, b: T): number => a.name.localeCompare(b.name)

/** The agents an agent routine can pick once a team is chosen, by name. */
export function agentsForTeam(
  agents: readonly RoutineDirectoryAgent[],
  teamId: string,
): RoutineDirectoryAgent[] {
  return agents
    .filter((a) => (teamId === NO_TEAM ? a.teamId == null : a.teamId === teamId))
    .sort(byName)
}

export function sortedTeams(teams: readonly RoutineDirectoryTeam[]): RoutineDirectoryTeam[] {
  return [...teams].sort(byName)
}

/** A new routine starts as a team routine, on the team being looked at when
 *  there is one, else the first team by name. */
export function emptyRoutineForm(
  teams: readonly RoutineDirectoryTeam[],
  preferredTeamId?: string | null,
): RoutineFormValues {
  const preferred = preferredTeamId && teams.some((t) => t.id === preferredTeamId)
  return {
    kind: 'team',
    teamId: preferred ? preferredTeamId : (sortedTeams(teams)[0]?.id ?? ''),
    agentId: '',
    name: '',
    instructions: '',
    cron: DEFAULT_CRON,
  }
}

export function routineFormFromRecord(rec: ScheduleRecord): RoutineFormValues {
  const kind = routineKindOf(rec)
  return {
    kind,
    teamId: rec.teamId ?? (kind === 'agent' ? NO_TEAM : ''),
    agentId: kind === 'agent' ? rec.agentId : '',
    name: rec.label ?? '',
    instructions: rec.description ?? '',
    cron: rec.cronSpec,
  }
}

function resolvedName(v: RoutineFormValues): string {
  return v.name.trim() || deriveRoutineName(v.instructions)
}

/** What stops the form from being saved, or null when it can be. */
export function routineFormProblem(
  v: RoutineFormValues,
  opts: { checkSchedule: boolean },
): string | null {
  if (v.kind === 'team' && (!v.teamId || v.teamId === NO_TEAM)) return 'Choose a team.'
  if (v.kind === 'agent' && !v.agentId) return 'Choose an agent.'
  if (!resolvedName(v)) return 'Say what the routine should do.'
  if (opts.checkSchedule) return cronError(v.cron)
  return null
}

export function buildRoutineCreateSpec(v: RoutineFormValues): ScheduleCreateSpec {
  const base = {
    source: 'clawboo-routine' as const,
    domain: 'team-task' as const,
    cronSpec: v.cron.trim(),
    label: resolvedName(v),
    taskTemplate: { description: v.instructions.trim() },
  }
  return v.kind === 'team'
    ? { ...base, target: 'team', teamId: v.teamId }
    : {
        ...base,
        target: 'agent',
        agentId: v.agentId,
        teamId: v.teamId === NO_TEAM ? null : v.teamId,
      }
}

/**
 * The fields an edit changed, or null when it changed nothing. Only changed
 * fields are sent: re-sending an untouched target would re-validate it, and an
 * agent that has since moved teams would then refuse a save that never touched
 * who the routine goes to.
 */
export function buildRoutinePatch(
  initial: RoutineFormValues,
  v: RoutineFormValues,
): ScheduleUpdatePatch | null {
  const patch: ScheduleUpdatePatch = {}
  if (resolvedName(v) !== resolvedName(initial)) patch.label = resolvedName(v)
  if (v.instructions.trim() !== initial.instructions.trim())
    patch.taskTemplate = { description: v.instructions.trim() }
  if (v.cron.trim() !== initial.cron.trim()) patch.cronSpec = v.cron.trim()
  const retargeted =
    v.kind !== initial.kind ||
    v.teamId !== initial.teamId ||
    (v.kind === 'agent' && v.agentId !== initial.agentId)
  if (retargeted) {
    patch.target = v.kind
    patch.teamId = v.teamId === NO_TEAM ? null : v.teamId
    patch.agentId = v.kind === 'agent' ? v.agentId : null
  }
  return Object.keys(patch).length > 0 ? patch : null
}

// ─── Run history ─────────────────────────────────────────────────────────────

export type RoutineRunStatus = 'running' | 'succeeded' | 'failed' | 'interrupted'

/** A fire's pill. A team fire "succeeds" once the lead has taken the message, so
 *  it reads as posted; the team's work then continues in the chat. */
export function runPill(
  status: RoutineRunStatus,
  kind: 'team' | 'agent',
): { tone: StatusTone; label: string } {
  switch (status) {
    case 'running':
      return { tone: 'working', label: 'running' }
    case 'succeeded':
      return { tone: 'success', label: kind === 'team' ? 'posted' : 'done' }
    case 'failed':
      return { tone: 'error', label: 'failed' }
    case 'interrupted':
      return { tone: 'warning', label: 'interrupted' }
  }
}

export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m ${s % 60}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

// ─── Runtime names ───────────────────────────────────────────────────────────

const BRANDED_RUNTIMES = new Set<string>(['clawboo-native', 'claude-code', 'codex', 'hermes'])

/** A runtime id as people read it; an unknown id is shown as-is. */
export function runtimeDisplayName(id: string): string {
  if (id === 'openclaw') return 'OpenClaw'
  return BRANDED_RUNTIMES.has(id) ? RUNTIME_CATALOG[id as RuntimeId].name : id
}

// ─── Cadence in plain words ──────────────────────────────────────────────────

const WEEKDAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']

function clockLabel(hour: number, minute: number): string {
  return new Date(2000, 0, 1, hour, minute).toLocaleTimeString(undefined, {
    hour: 'numeric',
    minute: '2-digit',
  })
}

function ordinal(n: number): string {
  const tens = n % 100
  if (tens >= 11 && tens <= 13) return `${n}th`
  return `${n}${['th', 'st', 'nd', 'rd'][n % 10] ?? 'th'}`
}

function inRange(v: string, lo: number, hi: number): boolean {
  return /^\d+$/.test(v) && Number(v) >= lo && Number(v) <= hi
}

/** Weekdays a day-of-week field names (0 is Sunday; 7 also means Sunday), or
 *  null for a form this does not read (names, steps). */
function parseWeekdays(field: string): Set<number> | null {
  const days = new Set<number>()
  for (const part of field.split(',')) {
    const range = /^(\d)-(\d)$/.exec(part)
    if (range) {
      const from = Number(range[1])
      const to = Number(range[2])
      if (from > 7 || to > 7 || from > to) return null
      for (let d = from; d <= to; d++) days.add(d % 7)
    } else if (inRange(part, 0, 7)) {
      days.add(Number(part) % 7)
    } else {
      return null
    }
  }
  return days
}

function listWords(words: string[]): string {
  if (words.length <= 1) return words.join('')
  return `${words.slice(0, -1).join(', ')} and ${words[words.length - 1]}`
}

/**
 * A routine's schedule as a person says it: "Weekdays at 9:00 AM", "Every
 * hour", "Mondays at 9:00 AM", "Every 15 minutes". Common five-field cron forms
 * and one-shots are read; anything else falls back to `humanCron`, which names a
 * preset or shows the expression as written.
 */
export function describeCadence(spec: string): string {
  const s = spec.trim()
  if (isOnceSpec(s)) {
    const ms = Date.parse(s.slice(ONCE_PREFIX.length))
    return Number.isNaN(ms) ? s : `Once, ${formatWhen(ms)}`
  }
  const fields = s.split(/\s+/)
  if (fields.length !== 5) return humanCron(s)
  const [min, hour, dom, mon, dow] = fields as [string, string, string, string, string]
  const fixedTime = inRange(min, 0, 59) && inRange(hour, 0, 23)
  const at = fixedTime ? clockLabel(Number(hour), Number(min)) : ''

  if (mon !== '*') return humanCron(s)
  if (dom !== '*') {
    return dow === '*' && fixedTime && inRange(dom, 1, 31)
      ? `Monthly on the ${ordinal(Number(dom))} at ${at}`
      : humanCron(s)
  }

  // A cadence within the day, before any day-of-week narrowing.
  let within: string | null = null
  if (fixedTime) {
    within = null
  } else if (hour === '*') {
    if (min === '*') within = 'Every minute'
    else {
      const every = /^\*\/(\d+)$/.exec(min)
      if (every)
        within = Number(every[1]) === 1 ? 'Every minute' : `Every ${Number(every[1])} minutes`
      else if (inRange(min, 0, 59))
        within = Number(min) === 0 ? 'Every hour' : `Every hour at :${min.padStart(2, '0')}`
    }
  } else {
    const everyHours = /^\*\/(\d+)$/.exec(hour)
    if (everyHours && inRange(min, 0, 59)) {
      const n = Number(everyHours[1])
      const base = n === 1 ? 'Every hour' : `Every ${n} hours`
      within = Number(min) === 0 ? base : `${base} at :${min.padStart(2, '0')}`
    }
  }
  if (!fixedTime && within === null) return humanCron(s)

  if (dow === '*') return within ?? `Daily at ${at}`

  const days = parseWeekdays(dow)
  if (!days || days.size === 0) return humanCron(s)
  const sorted = [...days].sort((a, b) => a - b)
  const key = sorted.join()
  if (days.size === 7) return within ?? `Daily at ${at}`
  if (within) {
    const on =
      key === '1,2,3,4,5'
        ? 'on weekdays'
        : key === '0,6'
          ? 'on weekends'
          : days.size === 1
            ? `on ${WEEKDAY_NAMES[sorted[0]!]}s`
            : `on ${listWords(sorted.map((d) => WEEKDAY_NAMES[d]!.slice(0, 3)))}`
    return `${within} ${on}`
  }
  if (key === '1,2,3,4,5') return `Weekdays at ${at}`
  if (key === '0,6') return `Weekends at ${at}`
  if (days.size === 1) return `${WEEKDAY_NAMES[sorted[0]!]}s at ${at}`
  return `${listWords(sorted.map((d) => WEEKDAY_NAMES[d]!.slice(0, 3)))} at ${at}`
}

/** What a fire of this routine does, in one honest sentence. */
export function fireSummary(
  rec: Pick<ScheduleRecord, 'target' | 'teamName' | 'agentName'>,
): string {
  if (routineKindOf(rec) === 'team') {
    const team = rec.teamName ? `the ${rec.teamName} team chat` : 'its team chat'
    const lead = rec.agentName ?? 'the team lead'
    return `When it runs, it posts to ${team}, and ${lead} takes it from there.`
  }
  return `When it runs, it becomes a task for ${rec.agentName ?? 'its agent'}.`
}
