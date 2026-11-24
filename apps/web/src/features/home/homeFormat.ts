// Words and numbers for Home. Pure functions, so the rules for what a number says
// about where it came from are tested on their own.
//
// THE RULE: every number Home shows says where it came from. A computed reading
// says "computed from the board" (or from runs and budgets), an agent's says which
// agent reported it and from which run, a person's says who typed it.

import type {
  GoalHealth,
  GoalProgress,
  HomeActor,
  HomeComputedMetric,
  KpiPeriod,
  KpiReading,
  KpiSource,
  KpiTile,
  TeamKpi,
} from '@clawboo/control-client'
import { HOME_POINT_IN_TIME_METRICS } from '@clawboo/control-client'

import { ATTENTION_META } from '@/features/board/boardStatus'

// ─── Health ──────────────────────────────────────────────────────────────────

export const HEALTH_LABEL: Record<GoalHealth, string> = {
  on_track: 'On track',
  at_risk: 'At risk',
  off_track: 'Off track',
}

/** The token a health dot is drawn in. No health set is a neutral ring. */
export function healthColor(health: GoalHealth | null): string {
  switch (health) {
    case 'on_track':
      return 'var(--mint)'
    case 'at_risk':
      return 'var(--amber)'
    case 'off_track':
      return 'var(--destructive)'
    default:
      return 'var(--border-strong)'
  }
}

export function healthLabel(health: GoalHealth | null): string {
  return health ? HEALTH_LABEL[health] : 'No health set'
}

// ─── People and agents ───────────────────────────────────────────────────────

/** A name for whoever did something. The person using the page reads "you". */
export function actorName(
  actor: HomeActor | null,
  opts: { meId?: string | null; agentName?: (id: string) => string | null } = {},
): string {
  if (!actor) return 'someone'
  if (actor.kind === 'person') {
    if (opts.meId && actor.id === opts.meId) return 'you'
    if (actor.name && actor.name.toLowerCase() === 'you') return 'you'
    return actor.name || 'a person'
  }
  return opts.agentName?.(actor.id) ?? actor.name ?? 'an agent'
}

// ─── Numbers ─────────────────────────────────────────────────────────────────

function trimNumber(n: number, maxDecimals: number): string {
  const fixed = n.toFixed(maxDecimals)
  return fixed.includes('.') ? fixed.replace(/\.?0+$/, '') : fixed
}

/** A plain number, grouped, with up to two decimals for small values. */
export function formatNumber(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1000) return Math.round(n).toLocaleString('en-US')
  if (abs >= 100) return trimNumber(n, 0)
  if (abs >= 10) return trimNumber(n, 1)
  return trimNumber(n, 2)
}

/** Dollars as Home shows them: cents shown, thousands grouped. */
export function formatUsd(n: number): string {
  const abs = Math.abs(n)
  if (abs >= 1000) return `$${Math.round(n).toLocaleString('en-US')}`
  if (abs > 0 && abs < 0.01) return `$${n.toFixed(4)}`
  return `$${n.toFixed(2)}`
}

/** A value in its KPI's unit: `$` leads, `%` trails tight, other units trail. */
export function formatKpiValue(value: number, unit: string): string {
  const u = unit.trim()
  if (u === '$') return formatUsd(value)
  if (u === '%') return `${formatNumber(value)}%`
  return u ? `${formatNumber(value)} ${u}` : formatNumber(value)
}

// ─── Progress ────────────────────────────────────────────────────────────────

/** Done over counted, as a whole percent. Zero tasks is zero. */
export function progressPercent(p: Pick<GoalProgress, 'done' | 'total'>): number {
  if (p.total <= 0) return 0
  return Math.round((p.done / p.total) * 100)
}

/** "3 of 8 tasks done" plus how many passed their check. */
export function progressWords(p: GoalProgress): string {
  if (p.total === 0) return 'No linked tasks yet'
  const base = `${p.done} of ${p.total} ${p.total === 1 ? 'task' : 'tasks'} done`
  return p.done > 0 ? `${base}, ${p.doneChecked} checked` : base
}

/** How the scope moved this week, like "+3 added, 2 done this week". Null when
 *  nothing moved. */
export function scopeWords(p: GoalProgress): string | null {
  const parts: string[] = []
  if (p.addedLast7Days > 0) parts.push(`+${p.addedLast7Days} added`)
  if (p.doneLast7Days > 0) parts.push(`${p.doneLast7Days} done`)
  return parts.length ? `${parts.join(', ')} this week` : null
}

// ─── KPIs ────────────────────────────────────────────────────────────────────

export const METRIC_LABEL: Record<HomeComputedMetric, string> = {
  tasks_done: 'Tasks done',
  tasks_checked_done: 'Tasks done and checked',
  requests_done: 'Requests finished',
  spend_usd: 'Spend',
  budget_used_pct: 'Budget used',
  run_success_rate: 'Runs that succeeded',
  needs_you_count: 'Tasks waiting on you',
  median_hours_to_done: 'Median hours to done',
  open_requests: 'Open requests',
}

export const METRIC_HINT: Record<HomeComputedMetric, string> = {
  tasks_done: 'Tasks moved to Done. Requests themselves are not counted.',
  tasks_checked_done: 'Tasks moved to Done whose check passed.',
  requests_done: "People's requests finished.",
  spend_usd: "What the team's runs cost, estimates included.",
  budget_used_pct: "The team budget's spend over its limit, now.",
  run_success_rate: 'Finished runs that succeeded, as a percent.',
  needs_you_count: 'Tasks waiting on a person, now.',
  median_hours_to_done: 'Median hours from created to Done, for tasks done in the period.',
  open_requests: "People's requests still open, now.",
}

export const PERIOD_LABEL: Record<KpiPeriod, string> = {
  week: 'Last 7 days',
  month: 'Last 30 days',
  quarter: 'Last 90 days',
  all: 'All time',
}

export const SOURCE_LABEL: Record<KpiSource, string> = {
  computed: 'Computed',
  agent: 'Reported by an agent',
  person: 'Typed by a person',
}

export function isPointInTime(metric: HomeComputedMetric | null): boolean {
  return metric !== null && HOME_POINT_IN_TIME_METRICS.includes(metric)
}

/** Where a computed metric's number comes from, in words. */
export function computedFrom(metric: HomeComputedMetric | null): string {
  switch (metric) {
    case 'spend_usd':
    case 'run_success_rate':
      return 'computed from runs'
    case 'budget_used_pct':
      return 'computed from the budget'
    default:
      return 'computed from the board'
  }
}

/** The window a KPI reads, like "Last 7 days" or "Now". */
export function kpiWindow(kpi: Pick<TeamKpi, 'source' | 'metric' | 'period'>): string {
  if (kpi.source === 'computed' && isPointInTime(kpi.metric)) return 'Now'
  return PERIOD_LABEL[kpi.period]
}

/** How the target reads beside the value, like "target 100 signups". */
export function targetWords(kpi: Pick<TeamKpi, 'target' | 'unit' | 'direction'>): string | null {
  if (kpi.target === null) return null
  const value = formatKpiValue(kpi.target, kpi.unit)
  return kpi.direction === 'down' ? `target at most ${value}` : `target ${value}`
}

/** Whether the reading meets its target, in the KPI's direction. Null with no
 *  target or no value. */
export function meetsTarget(tile: KpiTile): boolean | null {
  const { target, direction } = tile.kpi
  const { value } = tile.reading
  if (target === null || value === null) return null
  return direction === 'down' ? value <= target : value >= target
}

/** How far toward the target, 0 to 100, for a bar. Null when it has no meaning
 *  (no target, no value, or a lower-is-better KPI). */
export function targetPercent(tile: KpiTile): number | null {
  const { target, direction } = tile.kpi
  const { value } = tile.reading
  if (target === null || value === null || direction === 'down' || target <= 0) return null
  return Math.max(0, Math.min(100, Math.round((value / target) * 100)))
}

/** The short source badge text, like "Computed", "Researcher" or "You". */
export function sourceBadge(
  tile: KpiTile,
  opts: { meId?: string | null; agentName?: (id: string) => string | null } = {},
): string {
  const { reading } = tile
  if (reading.source === 'computed') return 'Computed'
  const who = reading.latest?.reportedBy ?? null
  if (!who) return reading.source === 'agent' ? 'Agent' : 'Person'
  const name = actorName(who, opts)
  return name === 'you' ? 'You' : name
}

/** The full line under a value: where it came from and when, for a title or a
 *  screen reader. */
export function provenanceWords(
  tile: KpiTile,
  now: number,
  opts: { meId?: string | null; agentName?: (id: string) => string | null } = {},
): string {
  const { reading, kpi } = tile
  if (reading.source === 'computed') {
    const when = reading.asOf !== null ? `, as of ${relativeTime(reading.asOf, now)}` : ''
    return `${capitalize(computedFrom(kpi.metric))}${when}`
  }
  if (reading.freshness === 'missing' || !reading.latest) {
    return reading.source === 'agent' ? 'No value reported yet' : 'No value typed yet'
  }
  const who = actorName(reading.latest.reportedBy, opts)
  const verb = reading.source === 'agent' ? 'Reported by' : 'Typed by'
  const when = reading.asOf !== null ? ` ${relativeTime(reading.asOf, now)}` : ''
  return `${verb} ${who}${when}`
}

/** Why a value is stale, or null when it is not. */
/** Whether a KPI's value is stale now: as the server said when it was read, or because
 *  the clock has since passed the KPI's stale threshold (a tile or dialog left open
 *  turns stale without a new read). The server's rule: older than `staleAfterHours`. */
export function isStale(tile: KpiTile, now: number): boolean {
  const { reading, kpi } = tile
  if (reading.freshness === 'stale') return true
  if (reading.freshness !== 'ok' || kpi.source === 'computed') return false
  return (
    reading.asOf !== null &&
    kpi.staleAfterHours !== null &&
    now - reading.asOf > kpi.staleAfterHours * 60 * 60 * 1000
  )
}

export function staleWords(tile: KpiTile, now: number): string | null {
  if (!isStale(tile, now)) return null
  const hours = tile.kpi.staleAfterHours
  const asOf = tile.reading.asOf
  if (asOf === null) return 'Stale'
  return hours !== null
    ? `Stale: last value ${relativeTime(asOf, now)}, expected every ${formatHours(hours)}`
    : `Stale: last value ${relativeTime(asOf, now)}`
}

export function formatHours(hours: number): string {
  if (hours % 24 === 0) {
    const days = hours / 24
    return days === 1 ? 'day' : `${days} days`
  }
  return hours === 1 ? 'hour' : `${hours} hours`
}

/** The reading's value as text, or a dash when there is none. */
export function readingText(reading: KpiReading, unit: string): string {
  return reading.value === null ? 'No value' : formatKpiValue(reading.value, unit)
}

// ─── Needs you ───────────────────────────────────────────────────────────────

/** The Board's word for why a task waits on a person. */
export function reasonLabel(reason: string): string {
  const meta = (ATTENTION_META as Record<string, { label: string } | undefined>)[reason]
  return meta?.label ?? capitalize(reason.replace(/_/g, ' '))
}

// ─── Time ────────────────────────────────────────────────────────────────────

/** How far ahead of the page's clock a time may be and still read "just now". */
const CLOCK_SKEW_MS = 2 * 60_000

/** "just now", "5m ago", "3h ago", "2d ago"; a future time reads "in 3h". */
export function relativeTime(at: number, now: number): string {
  const diff = now - at
  // A read stamped a moment after the page's clock last ticked is not "in the
  // future": the two clocks are a few seconds apart, so it is just now.
  if (diff < 0 && diff > -CLOCK_SKEW_MS) return 'just now'
  const future = diff < 0
  const s = Math.floor(Math.abs(diff) / 1000)
  if (s < 45) return future ? 'in a moment' : 'just now'
  const m = Math.floor(s / 60)
  const h = Math.floor(m / 60)
  const d = Math.floor(h / 24)
  const span = m < 60 ? `${Math.max(1, m)}m` : h < 24 ? `${h}h` : `${d}d`
  return future ? `in ${span}` : `${span} ago`
}

const DATE_FMT = new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric' })
const DATE_YEAR_FMT = new Intl.DateTimeFormat('en-US', {
  month: 'short',
  day: 'numeric',
  year: 'numeric',
})
const WHEN_FMT = new Intl.DateTimeFormat('en-US', {
  weekday: 'short',
  hour: 'numeric',
  minute: '2-digit',
})

/** "Dec 4", with the year when it is not this year's. */
export function formatDate(at: number, now: number): string {
  const sameYear = new Date(at).getFullYear() === new Date(now).getFullYear()
  return (sameYear ? DATE_FMT : DATE_YEAR_FMT).format(at)
}

/** A goal's target date in words, with how far off it is. */
export function targetDateWords(at: number, now: number): { text: string; overdue: boolean } {
  const days = Math.round((startOfDay(at) - startOfDay(now)) / 86_400_000)
  const date = formatDate(at, now)
  if (days < 0) return { text: `Due ${date}, ${-days}d late`, overdue: true }
  if (days === 0) return { text: `Due today`, overdue: false }
  if (days === 1) return { text: `Due tomorrow`, overdue: false }
  return { text: `Due ${date}`, overdue: false }
}

/** When a routine runs next, like "Tue 9:00 AM" this week, else a date. */
export function nextRunWords(at: number, now: number): string {
  if (at - now < 6 * 86_400_000) return WHEN_FMT.format(at)
  return formatDate(at, now)
}

function startOfDay(at: number): number {
  const d = new Date(at)
  d.setHours(0, 0, 0, 0)
  return d.getTime()
}

/** A date input's value (yyyy-mm-dd, local) for an epoch, and back. */
export function toDateInput(at: number | null): string {
  if (at === null) return ''
  const d = new Date(at)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return `${d.getFullYear()}-${mm}-${dd}`
}

export function fromDateInput(value: string): number | null {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value)
  if (!m) return null
  // Noon local, so a time zone shift never moves it to another day.
  return new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]), 12).getTime()
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${trimNumber(n / 1024, 1)} KB`
  return `${trimNumber(n / (1024 * 1024), 1)} MB`
}

function capitalize(s: string): string {
  return s ? s[0]!.toUpperCase() + s.slice(1) : s
}
