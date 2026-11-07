// Attempt classification — reading the execution ledger back as a story.
//
// THE PROBLEM. Clawboo caps re-fires, and there are two very different loops:
//
//   - a task whose PROCESS keeps dying (an orphan reap, a stale sweep), and
//   - a task that runs fine and keeps FAILING (a red gate, a thrown driver).
//
// The fire policy counts them apart (`trailingRunFailures` in @clawboo/board-core).
// This reads the same ledger back for whoever has to explain it: a delegator is told
// which it was, and the next attempt gets the context that fits.
//
// DERIVED, NEVER STORED. There is no attempt-counter column and there should not
// be: a stored count can drift from the rows it duplicates, and the ledger is
// already the fire policy's input. Everything here reads existing columns.
//
// TWO READERS, ONE LEDGER. The executor runner and the team engine both read
// this: the executor for its interrupted-work note, the engine for the ticket
// block's "last attempt". The engine writes `timed_out` for its own watchdog (a
// run that went silent while its process lived), so a `timed_out` row is a
// crash only when the stale sweep wrote it.

import {
  isFinishedRun,
  ORPHANED_RUN_ERROR,
  runKindOf,
  STALE_RUN_ERROR,
  trailingRunFailures,
  type RunKind,
} from '@clawboo/board-core'

export { ORPHANED_RUN_ERROR, STALE_RUN_ERROR }

/** How the most recent attempt ended. `timeout`: a watchdog stopped a run that
 *  had gone silent while its process lived (the team engine's, or the OpenClaw
 *  routine dispatcher's). `budget`, `breaker`: the host stopped it. */
export type AttemptKind = RunKind

/** The shape this reads. A subset of `DbExecutionProcess`, so a caller can pass
 *  rows straight from `listExecutions` without mapping. */
export interface AttemptRow {
  status: string
  error?: string | null
  errorClass?: string | null
  recoveryTombstone?: number | null
  afterCommit?: string | null
  summary?: string | null
}

export interface AttemptSummary {
  /** TRAILING streak of attempts whose process died before reporting an outcome. */
  crashAttempts: number
  /** TRAILING streak of attempts that ran and failed: they reported an error, or
   *  went silent and a watchdog stopped them. */
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
  /** Why the newest attempt ended, as its row records it, whatever its kind: the
   *  error it failed with, the watchdog's reason, the crash's tombstone, or why
   *  it was stopped. Null when the row records none. */
  lastReason: string | null
}

/**
 * How a run ended is `runKindOf` in @clawboo/board-core, the rule the fire policy reads
 * too, so the two never disagree.
 *
 * A crash is a run that never got to report. Two writers produce one:
 * `reconcileOrphans` (the process died with the previous server) sets
 * `recoveryTombstone`, and `reconcileStaleInProgress` (the drain stopped beating)
 * writes a `timed_out` row with `STALE_RUN_ERROR`.
 *
 * Any other `timed_out` row is a watchdog's: the team engine's idle watchdog or
 * the OpenClaw routine dispatcher's stopped a run whose process was alive. That
 * is a timeout, not a crash.
 *
 * `budget` and `breaker` are the host stopping a run, each with its own status.
 * A budget stop neither counts in a streak nor ends one, and a breaker trip ends one.
 *
 * Anything else that failed actually ran, which is an error attempt.
 *
 * `cancelled` always breaks a streak. A user Stop is intent, not a symptom. The
 * team engine also closes two kinds of run `cancelled`: one whose task a person
 * finished while it ran (the task is then done or cancelled, so it does not run
 * again), and one whose result came back after its task was released. That run
 * finished, so it ends a failure streak as truly as a success would.
 * `lastReason` says which it was.
 */

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
    lastReason: null,
  }
  // A row that has not FINISHED is not an attempt: a concurrent dispatch's
  // still-`running` row (or a leaked one) would otherwise classify as an error,
  // inflate the streak, and even become `lastKind`. The caller filters its OWN
  // open row; this covers everyone else's. The fire policy's streak skips the
  // same rows (`isFinishedRun`), so the two readers agree.
  const terminal = execs.filter((e) => isFinishedRun(e.status))
  if (terminal.length === 0) return empty

  const last = terminal[terminal.length - 1]!
  const lastKind = runKindOf(last)
  const { crashes, errors } = trailingRunFailures(terminal)

  return {
    crashAttempts: crashes,
    errorAttempts: errors,
    lastKind,
    // Evidence, not inference: a moved commit or a recorded summary means the
    // attempt got far enough to do something. Claiming work exists when it does
    // not would send the next attempt hunting for a phantom.
    lastCrashLeftWork:
      lastKind === 'crash' && Boolean((last.afterCommit ?? '') || (last.summary ?? '')),
    lastCrashReason: lastKind === 'crash' ? (last.error ?? null) : null,
    lastReason: last.error?.trim() ? last.error : null,
  }
}
