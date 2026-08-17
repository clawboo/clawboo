// Attempt classification — reading the execution ledger back as a story.
//
// THE PROBLEM. Clawboo already caps re-fires: `isLedgerAutoFireable` counts the
// trailing streak of non-succeeded runs against MAX_AUTO_FIRES, and crash-reaps
// count because `reconcileOrphans` writes `status: 'failed'`. What it does NOT do
// is distinguish two very different loops:
//
//   - a task whose PROCESS keeps dying (an orphan reap, a stale sweep), and
//   - a task that runs fine and keeps FAILING (a red gate, a thrown driver).
//
// Both currently look like the same streak, so a delegator is told the same thing
// either way, and the next attempt is given the same (nonexistent) context. The
// data to tell them apart is already on the ledger; only the reading was missing.
//
// DERIVED, NEVER STORED. There is no attempt-counter column and there should not
// be: a stored count can drift from the rows it duplicates, and the ledger is
// already the fire policy's input. Everything here reads existing columns.

/** How the most recent attempt ended. */
export type AttemptKind = 'crash' | 'error' | 'success' | 'cancelled'

/** The shape this reads. A subset of `DbExecutionProcess`, so a caller can pass
 *  rows straight from `listExecutions` without mapping. */
export interface AttemptRow {
  status: string
  error?: string | null
  recoveryTombstone?: number | null
  afterCommit?: string | null
  summary?: string | null
}

export interface AttemptSummary {
  /** TRAILING streak of attempts whose process died before reporting an outcome. */
  crashAttempts: number
  /** TRAILING streak of attempts that ran and reported a failure. */
  errorAttempts: number
  /** How the newest attempt ended, or null for a task that has never run. */
  lastKind: AttemptKind | null
  /**
   * True when the newest attempt was a CRASH and left evidence that work was in
   * flight: a commit moved, or it recorded a partial summary. This is the
   * difference between "nothing to pick up" and "something may be half-done", and
   * it is the only thing that decides which resume note the next attempt gets.
   */
  lastCrashLeftWork: boolean
  /** The tombstone text of the newest crash, for telling the next attempt WHY. */
  lastCrashReason: string | null
}

/**
 * A crash is a run that never got to report. Two writers produce one:
 * `reconcileOrphans` (the process died with the previous server) sets
 * `recoveryTombstone`, and `reconcileStaleInProgress` (the drain stopped beating)
 * writes a `timed_out` row whose error names the watchdog.
 *
 * Anything else that failed actually ran, which is an error attempt.
 */
function kindOf(row: AttemptRow): AttemptKind {
  if (row.status === 'succeeded') return 'success'
  if (row.status === 'cancelled') return 'cancelled'
  if (row.recoveryTombstone === 1) return 'crash'
  if (row.status === 'timed_out') return 'crash'
  return 'error'
}

/**
 * Classify a task's ledger, oldest first (the order `listExecutions` returns).
 *
 * Streaks are TRAILING and reset on a success, matching the fire policy: a task
 * that failed twice, succeeded, then crashed once has crashed once, not three
 * times. `cancelled` also breaks a streak, because a user Stop is intent rather
 * than a symptom.
 */
export function classifyAttempts(execs: AttemptRow[]): AttemptSummary {
  const empty: AttemptSummary = {
    crashAttempts: 0,
    errorAttempts: 0,
    lastKind: null,
    lastCrashLeftWork: false,
    lastCrashReason: null,
  }
  if (execs.length === 0) return empty

  const last = execs[execs.length - 1]!
  const lastKind = kindOf(last)

  let crashAttempts = 0
  let errorAttempts = 0
  for (let i = execs.length - 1; i >= 0; i--) {
    const k = kindOf(execs[i]!)
    if (k === 'success' || k === 'cancelled') break
    if (k === 'crash') crashAttempts += 1
    else errorAttempts += 1
  }

  return {
    crashAttempts,
    errorAttempts,
    lastKind,
    // Evidence, not inference: a moved commit or a recorded summary means the
    // attempt got far enough to do something. Claiming work exists when it does
    // not would send the next attempt hunting for a phantom.
    lastCrashLeftWork:
      lastKind === 'crash' && Boolean((last.afterCommit ?? '') || (last.summary ?? '')),
    lastCrashReason: lastKind === 'crash' ? (last.error ?? null) : null,
  }
}
