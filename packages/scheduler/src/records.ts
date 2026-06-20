// The normalized schedule row every source projects into — the unified
// Scheduler surface's lingua franca. The `domain` field keeps the merged view
// honest: runtime-own-life rows (a runtime's own standalone cron) and
// team-task rows (clawboo Routines) are visible together, never conflated.

export type ScheduleSourceId = 'clawboo-routine' | 'openclaw-gateway-cron'

export type ScheduleDomain = 'team-task' | 'runtime-own-life'

/**
 * The write-gate tier. The UI is a pure function of this — it may never offer
 * an action the owner forbids.
 * - 'managed': clawboo fully owns the rows (the Routines ledger).
 * - 'external-write': an external system owns them; clawboo reads + writes
 *   through that system's own API as an operator surface.
 * - 'observe-only': clawboo can read but never write.
 */
export type ScheduleManageability = 'managed' | 'external-write' | 'observe-only'

export type ScheduleStatus = 'queued' | 'claimed' | 'running' | 'idle' | 'paused' | 'error'

export interface ScheduleRecord {
  /** Source-namespaced composite `${source}:${sourceScheduleId}`. Opaque to the UI. */
  id: string
  /** The raw id inside the owning system (ledger row id / gateway cron job id). */
  sourceScheduleId: string
  /** Runtime the schedule targets (open set: 'openclaw' | 'clawboo-native' | …). */
  runtime: string
  /** = scheduledBy: which engine FIRES this ('clawboo' | 'openclaw' | …). */
  owner: string
  source: ScheduleSourceId
  agentId: string
  /** Set only for team-task rows bound to an existing board task. */
  teamTaskId?: string
  label?: string
  /**
   * Canonical spec string: a bare cron expression (optionally `@tz:<tz>`
   * suffixed), `once@<iso>`, `every:<ms>[@anchor:<ms>]`, or `at:<iso>`.
   */
  cronSpec: string
  nextRunAt: number | null
  lastRunAt?: number
  lastError?: string
  status: ScheduleStatus
  manageability: ScheduleManageability
  /** Gateway-cron rows = the agent's own life; Routine rows = team work. */
  domain: ScheduleDomain
  /** Dormant multi-tenant seam — always null today. */
  tenantId: string | null
}

// ── Gateway schedule codec ───────────────────────────────────────────────────
// The OpenClaw Gateway models a schedule as a discriminated union; the unified
// surface flattens it into the canonical cronSpec string above. Declared
// locally so this package stays dependency-free of the gateway client.

export type GatewayCronScheduleShape =
  | { kind: 'cron'; expr: string; tz?: string }
  | { kind: 'every'; everyMs: number; anchorMs?: number }
  | { kind: 'at'; at: string }

const TZ_SUFFIX = '@tz:'
const EVERY_PREFIX = 'every:'
const ANCHOR_INFIX = '@anchor:'
const AT_PREFIX = 'at:'

export function encodeCronSpec(schedule: GatewayCronScheduleShape): string {
  switch (schedule.kind) {
    case 'cron':
      return schedule.tz ? `${schedule.expr}${TZ_SUFFIX}${schedule.tz}` : schedule.expr
    case 'every':
      return schedule.anchorMs != null
        ? `${EVERY_PREFIX}${schedule.everyMs}${ANCHOR_INFIX}${schedule.anchorMs}`
        : `${EVERY_PREFIX}${schedule.everyMs}`
    case 'at':
      return `${AT_PREFIX}${schedule.at}`
  }
}

/** Inverse of encodeCronSpec. An unprefixed spec is a cron expression. */
export function decodeCronSpec(spec: string): GatewayCronScheduleShape {
  if (spec.startsWith(EVERY_PREFIX)) {
    const body = spec.slice(EVERY_PREFIX.length)
    const anchorAt = body.indexOf(ANCHOR_INFIX)
    if (anchorAt >= 0) {
      return {
        kind: 'every',
        everyMs: Number(body.slice(0, anchorAt)),
        anchorMs: Number(body.slice(anchorAt + ANCHOR_INFIX.length)),
      }
    }
    return { kind: 'every', everyMs: Number(body) }
  }
  if (spec.startsWith(AT_PREFIX)) return { kind: 'at', at: spec.slice(AT_PREFIX.length) }
  const tzAt = spec.indexOf(TZ_SUFFIX)
  if (tzAt >= 0)
    return { kind: 'cron', expr: spec.slice(0, tzAt), tz: spec.slice(tzAt + TZ_SUFFIX.length) }
  return { kind: 'cron', expr: spec }
}
