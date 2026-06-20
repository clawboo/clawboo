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

/** Only `idle` rows with a non-null next_run_at are eligible for the due-pass. */
export function isAutoFireable(status: ScheduledRunStatus): boolean {
  return status === 'idle'
}

export function isScheduledRunStatus(value: unknown): value is ScheduledRunStatus {
  return typeof value === 'string' && (SCHEDULED_RUN_STATUSES as readonly string[]).includes(value)
}
