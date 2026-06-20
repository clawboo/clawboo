// ─── SQLite write-contention recipe ─────────────────────────────────────────
// clawboo is team-first: many agents may write one SQLite file. Without care,
// concurrent writers hit SQLite's single-writer lock and degrade into a "convoy".
// The recipe (from Hermes): WAL + busy_timeout + app-level jittered retry +
// BEGIN IMMEDIATE write transactions + a lean WAL via PASSIVE autocheckpoint.
//
// WAL, busy_timeout=1000, and wal_autocheckpoint=50 are set on every connection
// in `createDb` (db.ts). This module adds the app-level pieces: a jittered retry
// wrapper that only retries genuine lock errors, and a BEGIN IMMEDIATE helper.
//
// NOTE (deviation from the literal plan): we rely on SQLite's native
// `wal_autocheckpoint=50` PASSIVE checkpoint rather than an app-level
// write-counter — it's the SQLite-blessed mechanism and needs no access to the
// raw handle.

import type { ClawbooDb } from '../db'

/**
 * The transaction handle drizzle passes to `db.transaction(cb)` — the same query
 * API as ClawbooDb minus the raw `$client`. Derived from the driver so it tracks
 * the installed drizzle version rather than hard-coding `SQLiteTransaction<…>`.
 */
export type BoardTx = Parameters<Parameters<ClawbooDb['transaction']>[0]>[0]

const RETRY_MAX = 15
const JITTER_MIN_MS = 20
const JITTER_MAX_MS = 150

/** True for the transient lock errors that a retry can resolve. */
export function isBusyError(err: unknown): boolean {
  if (typeof err !== 'object' || err === null) return false
  const code = (err as { code?: unknown }).code
  return code === 'SQLITE_BUSY' || code === 'SQLITE_BUSY_SNAPSHOT' || code === 'SQLITE_LOCKED'
}

/**
 * Synchronous jittered sleep. better-sqlite3 is fully synchronous, so an async
 * sleep would force every repository method to become async. `Atomics.wait`
 * blocks the calling thread for `ms` without busy-spinning.
 */
function sleepSync(ms: number): void {
  const shared = new Int32Array(new SharedArrayBuffer(4))
  // index 0 holds 0; since it never changes, this always waits the full timeout.
  Atomics.wait(shared, 0, 0, ms)
}

function jitterMs(): number {
  return JITTER_MIN_MS + Math.floor(Math.random() * (JITTER_MAX_MS - JITTER_MIN_MS + 1))
}

/**
 * Run a synchronous write, retrying ONLY on transient SQLite lock errors with a
 * jittered backoff (20–150ms, ≤15 tries). A 0-row result (e.g. a lost claim
 * race) is data, not an exception — it is returned to the caller unretried, so
 * callers honour the "never retry a 409" rule.
 */
export function withWriteRetry<T>(fn: () => T): T {
  let attempt = 0
  for (;;) {
    try {
      return fn()
    } catch (err) {
      if (isBusyError(err) && attempt < RETRY_MAX) {
        attempt += 1
        sleepSync(jitterMs())
        continue
      }
      throw err
    }
  }
}

/**
 * Run `cb` inside a `BEGIN IMMEDIATE` transaction (acquires the write lock up
 * front, avoiding lock-escalation deadlocks), wrapped in the jittered retry.
 * The whole transaction re-runs from scratch on a transient lock error.
 */
export function immediateWrite<T>(db: ClawbooDb, cb: (tx: BoardTx) => T): T {
  return withWriteRetry(() => db.transaction(cb, { behavior: 'immediate' }))
}
