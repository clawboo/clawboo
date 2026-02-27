// ─── Cron Presets ─────────────────────────────────────────────────────────────

export interface CronPreset {
  label: string
  /** The everyMs value for 'every' kind schedules. */
  everyMs: number
  description: string
}

export const CRON_PRESETS: CronPreset[] = [
  { label: 'Every 5 minutes', everyMs: 5 * 60_000, description: 'Runs every 5 minutes' },
  { label: 'Every 15 minutes', everyMs: 15 * 60_000, description: 'Runs every 15 minutes' },
  { label: 'Every 30 minutes', everyMs: 30 * 60_000, description: 'Runs every 30 minutes' },
  { label: 'Every hour', everyMs: 60 * 60_000, description: 'Runs once per hour' },
  { label: 'Every 6 hours', everyMs: 6 * 3_600_000, description: 'Runs four times per day' },
  { label: 'Every 12 hours', everyMs: 12 * 3_600_000, description: 'Runs twice per day' },
  { label: 'Every day', everyMs: 24 * 3_600_000, description: 'Runs once per day' },
  { label: 'Every week', everyMs: 7 * 24 * 3_600_000, description: 'Runs once per week' },
]

// ─── Schedule formatting ───────────────────────────────────────────────────────

function formatEveryMs(everyMs: number): string {
  if (everyMs % (7 * 24 * 3_600_000) === 0) {
    const n = everyMs / (7 * 24 * 3_600_000)
    return `every ${n} week${n !== 1 ? 's' : ''}`
  }
  if (everyMs % (24 * 3_600_000) === 0) {
    const n = everyMs / (24 * 3_600_000)
    return `every ${n} day${n !== 1 ? 's' : ''}`
  }
  if (everyMs % 3_600_000 === 0) {
    const n = everyMs / 3_600_000
    return `every ${n} hour${n !== 1 ? 's' : ''}`
  }
  if (everyMs % 60_000 === 0) {
    const n = everyMs / 60_000
    return `every ${n} minute${n !== 1 ? 's' : ''}`
  }
  if (everyMs % 1_000 === 0) {
    const n = everyMs / 1_000
    return `every ${n} second${n !== 1 ? 's' : ''}`
  }
  return `every ${everyMs}ms`
}

export interface CronScheduleInput {
  kind: 'every' | 'at' | 'cron'
  everyMs?: number
  anchorMs?: number
  at?: string
  expr?: string
  tz?: string
}

export function formatScheduleHuman(schedule: CronScheduleInput): string {
  if (schedule.kind === 'every' && schedule.everyMs !== undefined) {
    return formatEveryMs(schedule.everyMs)
  }
  if (schedule.kind === 'cron' && schedule.expr) {
    return schedule.tz ? `cron: ${schedule.expr} (${schedule.tz})` : `cron: ${schedule.expr}`
  }
  if (schedule.kind === 'at' && schedule.at) {
    const d = new Date(schedule.at)
    if (!Number.isNaN(d.getTime())) {
      return `once at ${d.toLocaleString()}`
    }
    return `once at ${schedule.at}`
  }
  return 'unknown schedule'
}

// ─── Next execution time ───────────────────────────────────────────────────────

/**
 * Compute the next execution time (UTC ms) for an 'every' schedule.
 * Returns null if the schedule cannot be resolved.
 */
export function getNextExecution(
  schedule: CronScheduleInput,
  from: Date = new Date(),
): Date | null {
  if (schedule.kind === 'at' && schedule.at) {
    const d = new Date(schedule.at)
    return Number.isNaN(d.getTime()) ? null : d
  }

  if (schedule.kind === 'every' && schedule.everyMs !== undefined && schedule.everyMs > 0) {
    const nowMs = from.getTime()
    const everyMs = schedule.everyMs

    if (schedule.anchorMs !== undefined) {
      // Anchor-based: find the next occurrence after `from`
      const anchorMs = schedule.anchorMs
      if (anchorMs > nowMs) return new Date(anchorMs)
      const elapsed = nowMs - anchorMs
      const periods = Math.floor(elapsed / everyMs)
      const nextMs = anchorMs + (periods + 1) * everyMs
      return new Date(nextMs)
    }

    // No anchor — just add one interval from now
    return new Date(nowMs + everyMs)
  }

  // cron kind — we do not parse cron expressions in the browser; return null
  return null
}

// ─── Relative time formatter ───────────────────────────────────────────────────

/**
 * Format a date as a human-readable relative time string.
 * Examples: "in 3 minutes", "2 hours ago", "just now"
 */
export function formatRelativeTime(date: Date, from: Date = new Date()): string {
  const diffMs = date.getTime() - from.getTime()
  const absMs = Math.abs(diffMs)
  const future = diffMs > 0

  if (absMs < 5_000) return 'just now'

  const seconds = Math.round(absMs / 1_000)
  if (seconds < 60) {
    return future ? `in ${seconds}s` : `${seconds}s ago`
  }

  const minutes = Math.round(absMs / 60_000)
  if (minutes < 60) {
    return future ? `in ${minutes}m` : `${minutes}m ago`
  }

  const hours = Math.round(absMs / 3_600_000)
  if (hours < 24) {
    return future ? `in ${hours}h` : `${hours}h ago`
  }

  const days = Math.round(absMs / 86_400_000)
  return future ? `in ${days}d` : `${days}d ago`
}

// ─── Simple cron expression parser ────────────────────────────────────────────
// Handles the five-field standard cron format: min hour dom month dow
// Returns a human-readable description for common patterns only.

interface ParsedCron {
  isValid: boolean
  humanReadable: string
}

function parseCronField(field: string, unit: string, min: number, max: number): string | null {
  if (field === '*') return null // "every <unit>" — handled by caller
  if (/^\d+$/.test(field)) {
    const n = Number.parseInt(field, 10)
    if (n >= min && n <= max) return `${unit} ${n}`
    return null
  }
  if (/^\*\/\d+$/.test(field)) {
    const step = Number.parseInt(field.slice(2), 10)
    if (step > 0) return `every ${step} ${unit}${step !== 1 ? 's' : ''}`
    return null
  }
  return null // complex expression — show raw
}

export function parseCronExpression(expr: string): ParsedCron {
  const trimmed = expr.trim()
  if (!trimmed) return { isValid: false, humanReadable: 'Enter a cron expression' }

  const parts = trimmed.split(/\s+/)
  if (parts.length !== 5) {
    return {
      isValid: false,
      humanReadable: 'Must have 5 fields: minute hour day month weekday',
    }
  }

  const [minute, hour, dom, month, dow] = parts as [string, string, string, string, string]

  // Validate each field is a recognisable cron token
  const fieldPattern = /^(\*|\d+)(\/\d+)?(-\d+)?(,[\d*/-]+)*$/
  for (const f of [minute, hour, dom, month, dow]) {
    if (!fieldPattern.test(f)) {
      return { isValid: false, humanReadable: `Invalid field: "${f}"` }
    }
  }

  // Friendly descriptions for the most common patterns
  if (minute === '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return { isValid: true, humanReadable: 'every minute' }
  }

  if (/^\*\/\d+$/.test(minute) && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    const step = Number.parseInt(minute.slice(2), 10)
    return { isValid: true, humanReadable: `every ${step} minute${step !== 1 ? 's' : ''}` }
  }

  if (minute !== '*' && hour === '*' && dom === '*' && month === '*' && dow === '*') {
    return { isValid: true, humanReadable: `minute ${minute} of every hour` }
  }

  if (/^\d+$/.test(minute) && /^\d+$/.test(hour) && dom === '*' && month === '*' && dow === '*') {
    const h = Number.parseInt(hour, 10)
    const m = Number.parseInt(minute, 10)
    const hh = String(h).padStart(2, '0')
    const mm = String(m).padStart(2, '0')
    return { isValid: true, humanReadable: `daily at ${hh}:${mm}` }
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    dom === '*' &&
    month === '*' &&
    /^\d+$/.test(dow)
  ) {
    const h = Number.parseInt(hour, 10)
    const m = Number.parseInt(minute, 10)
    const hh = String(h).padStart(2, '0')
    const mm = String(m).padStart(2, '0')
    const days = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday']
    const dayName = days[Number.parseInt(dow, 10)] ?? `weekday ${dow}`
    return { isValid: true, humanReadable: `every ${dayName} at ${hh}:${mm}` }
  }

  if (
    /^\d+$/.test(minute) &&
    /^\d+$/.test(hour) &&
    /^\d+$/.test(dom) &&
    month === '*' &&
    dow === '*'
  ) {
    const h = Number.parseInt(hour, 10)
    const m = Number.parseInt(minute, 10)
    const d = Number.parseInt(dom, 10)
    const hh = String(h).padStart(2, '0')
    const mm = String(m).padStart(2, '0')
    return { isValid: true, humanReadable: `monthly on day ${d} at ${hh}:${mm}` }
  }

  // Try to build a partial description
  const minuteDesc = parseCronField(minute, 'minute', 0, 59)
  const hourDesc = parseCronField(hour, 'hour', 0, 23)

  if (minuteDesc || hourDesc) {
    const parts2 = [minuteDesc, hourDesc].filter(Boolean)
    return { isValid: true, humanReadable: parts2.join(', ') }
  }

  // Complex expression — valid syntax but no simple description
  return { isValid: true, humanReadable: `cron: ${trimmed}` }
}

// ─── Gateway payload type helpers ─────────────────────────────────────────────
// Gateway cron payload types (kept local to avoid a shared package dependency).

export type GatewayCronSchedule =
  | { kind: 'at'; at: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'cron'; expr: string; tz?: string }

export type GatewayCronPayload =
  | { kind: 'systemEvent'; text: string }
  | {
      kind: 'agentTurn'
      message: string
      model?: string
      thinking?: string
      timeoutSeconds?: number
    }

export type GatewayCronJobState = {
  nextRunAtMs?: number
  runningAtMs?: number
  lastRunAtMs?: number
  lastStatus?: 'ok' | 'error' | 'skipped'
  lastError?: string
  lastDurationMs?: number
}

export type GatewayCronJobSummary = {
  id: string
  name: string
  agentId?: string
  enabled: boolean
  updatedAtMs: number
  schedule: GatewayCronSchedule
  sessionTarget: 'main' | 'isolated'
  wakeMode: 'next-heartbeat' | 'now'
  payload: GatewayCronPayload
  state: GatewayCronJobState
}

export type GatewayCronJobsResult = {
  jobs: GatewayCronJobSummary[]
}

export type GatewayCronRunResult =
  | { ok: true; ran: true }
  | { ok: true; ran: false; reason: string }
  | { ok: false }

export type GatewayCronRemoveResult = { ok: true; removed: boolean } | { ok: false; removed: false }

export type GatewayCronCreateInput = {
  name: string
  agentId: string
  enabled?: boolean
  schedule: GatewayCronSchedule
  sessionTarget: 'main' | 'isolated'
  wakeMode: 'next-heartbeat' | 'now'
  payload: GatewayCronPayload
  delivery?: {
    mode: 'none' | 'announce'
    channel?: string
    to?: string
  }
}
