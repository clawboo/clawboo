// ─── Scheduled-run state machine ─────────────────────────────────────────────
// Pure transition rules for the Routines ledger. Enforced INSIDE the write
// transaction against the freshly-read row (the board state-machine pattern).
//
//   idle ──(next_run_at <= now)──► queued ──(atomic claim)──► claimed
//   claimed ──(dispatch in flight)──► running ──► idle (success, re-armed)
//                                            └──► error (lastError; disarmed)
//   claimed ──(dispatch threw before running)──► error
//   idle | queued | error ──(user)──► paused      (never auto-fires)
//   paused | error ──(user resume)──► idle        (re-armed by the caller)
//
// A successful `once@` fire re-enters `idle` with next_run_at NULL — the
// due-pass only queues non-null next_run_at, so the row is self-disabled.
// An errored recurring routine is DISARMED (next_run_at NULL) until a human
// resumes it: autonomous scheduled work must not silently retry-burn.

export type ScheduledRunStatus = 'idle' | 'queued' | 'claimed' | 'running' | 'paused' | 'error'

export const SCHEDULED_RUN_STATUSES: readonly ScheduledRunStatus[] = [
  'idle',
  'queued',
  'claimed',
  'running',
  'paused',
  'error',
]

const LEGAL: Record<ScheduledRunStatus, readonly ScheduledRunStatus[]> = {
  idle: ['queued', 'paused'],
  queued: ['claimed', 'paused', 'queued'],
  claimed: ['running', 'error', 'queued'], // claimed → queued is the boot-resume orphan reset
  running: ['idle', 'error', 'queued'], //    running → queued/idle via boot-resume healing
  paused: ['idle'],
  error: ['idle', 'paused'],
}

/** Same-status is an idempotent no-op (allowed). */
export function canRoutineTransition(from: ScheduledRunStatus, to: ScheduledRunStatus): boolean {
  if (from === to) return true
  return LEGAL[from]?.includes(to) ?? false
}

// What a person may do, a narrower set than LEGAL: that table also holds the
// engine's own moves, and `running → idle` there is a fire's outcome landing. A
// person pausing or resuming a fire still in flight would re-arm the row under
// it, so the next due-pass fires it again while the first run is still going.
const USER_LEGAL: Record<'paused' | 'idle', readonly ScheduledRunStatus[]> = {
  paused: ['idle', 'queued', 'error'],
  idle: ['paused', 'error'],
}

/** A person's pause (→ paused) or resume (→ idle). Same-status is a no-op. */
export function canUserSetRoutineStatus(from: ScheduledRunStatus, to: 'paused' | 'idle'): boolean {
  if (from === to) return true
  return USER_LEGAL[to].includes(from)
}

/** Only `idle` rows with a non-null next_run_at are eligible for the due-pass. */
export function isAutoFireable(status: ScheduledRunStatus): boolean {
  return status === 'idle'
}

export function isScheduledRunStatus(value: unknown): value is ScheduledRunStatus {
  return typeof value === 'string' && (SCHEDULED_RUN_STATUSES as readonly string[]).includes(value)
}
