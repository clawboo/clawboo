// ─── SQLite write-contention recipe ─────────────────────────────────────────
// clawboo is team-first: many agents may write one SQLite file. Without care,
// concurrent writers hit SQLite's single-writer lock and degrade into a "convoy".
// The recipe (from Hermes): WAL + busy_timeout + app-level jittered retry +
// BEGIN IMMEDIATE write transactions + a lean WAL via PASSIVE autocheckpoint.
//
// WAL, busy_timeout, and wal_autocheckpoint=50 are set on every connection in
// `openDb` (db.ts). This module adds the app-level pieces: a jittered retry
// wrapper that only retries genuine lock errors, and a BEGIN IMMEDIATE helper.
//
// NOTE (deviation from the literal plan): we rely on SQLite's native
// `wal_autocheckpoint=50` PASSIVE checkpoint rather than an app-level
// write-counter — it's the SQLite-blessed mechanism and needs no access to the
// raw handle.

import { BUSY_TIMEOUT_MS } from '../db'
import type { ClawbooDb } from '../db'

/**
 * The transaction handle drizzle passes to `db.transaction(cb)` — the same query
 * API as ClawbooDb minus the raw `$client`. Derived from the driver so it tracks
 * the installed drizzle version rather than hard-coding `SQLiteTransaction<…>`.
 */
export type BoardTx = Parameters<Parameters<ClawbooDb['transaction']>[0]>[0]

// ─── The retry budget ────────────────────────────────────────────────────────
// The budget is WALL-CLOCK, not an attempt count. `sleepSync` blocks the calling
// thread (better-sqlite3 is synchronous by design), and in the Express server
// that thread is the event loop — so the only number a user can actually feel is
// "how long can one contended write freeze the server", and an attempt count does
// not bound it:
//
//   before: 15 attempts × (busy_timeout 1000ms + jitter ≤150ms)   ≈ 17s
//   after:  a 1500ms deadline; the last attempt may still burn one
//           busy_timeout before the deadline is observed          ≈ 1.75s
//
// The attempt cap is a BACKSTOP, not the contract. It exists because
// SQLITE_BUSY_SNAPSHOT is returned WITHOUT invoking SQLite's busy handler, so
// those cycles cost only the jitter and 1500ms could buy 75 of them. 24 never
// binds in the deadline-driven case.
//
// SCOPE — the budget is per OUTERMOST write. It does not bound a request: a
// handler doing three writes can block for 3× the worst case. And it assumes the
// repository invariant that an `immediateWrite` body uses the `tx` handle
// directly and NEVER calls a `withWriteRetry`-wrapped function (every call site
// complies today) — nest them and the budgets multiply.

const RETRY_BUDGET_MS_DEFAULT = 1500
const RETRY_ATTEMPT_CAP = 24
const JITTER_MIN_MS = 20
const JITTER_MAX_MS = 150

/**
 * Wall-clock budget for one outermost write, tunable with
 * `CLAWBOO_DB_WRITE_BUDGET_MS`. Resolved per call (not at module load) so a test
 * or an operator can change it without a module reload.
 */
function resolveBudgetMs(): number {
  const raw = Number(process.env['CLAWBOO_DB_WRITE_BUDGET_MS'])
  return Number.isFinite(raw) && raw > 0 ? raw : RETRY_BUDGET_MS_DEFAULT
}

/**
 * Thrown when a write could not acquire the SQLite write lock inside the retry
 * budget. Carries `code = 'SQLITE_BUSY'` ON PURPOSE: `isBusyError` must still
 * recognise it, so any caller that already distinguishes "lock contention" from
 * "bad request" keeps working unchanged. The extra fields are for logs and for a
 * future 503-vs-500 decision at the REST edge.
 */
export class WriteBudgetExhaustedError extends Error {
  readonly code = 'SQLITE_BUSY'
  readonly attempts: number
  readonly budgetMs: number
  readonly elapsedMs: number

  constructor(input: { attempts: number; budgetMs: number; elapsedMs: number; cause: unknown }) {
    super(
      `SQLite write lock unavailable after ${input.attempts} attempts in ` +
        `${Math.round(input.elapsedMs)}ms (budget ${input.budgetMs}ms, ` +
        `busy_timeout ${BUSY_TIMEOUT_MS}ms)`,
      { cause: input.cause },
    )
    this.name = 'WriteBudgetExhaustedError'
    this.attempts = input.attempts
    this.budgetMs = input.budgetMs
    this.elapsedMs = input.elapsedMs
  }
}

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
 * Injectable clock/sleep — the deterministic-test seam, and a real parameter
 * rather than a mock because it CANNOT be one: `sleepSync` blocks on
 * `Atomics.wait`, which no fake-timer library can advance. Installing fake timers
 * here would freeze the clock while the sleep really blocks, spinning straight to
 * the attempt cap. Production callers pass nothing.
 */
export interface WriteRetryOptions {
  budgetMs?: number
  attemptCap?: number
  now?: () => number
  sleep?: (ms: number) => void
}

/**
 * Run a synchronous write, retrying ONLY transient SQLite lock errors with a
 * jittered backoff (20–150ms) until a wall-clock budget expires. A 0-row result
 * (e.g. a lost claim race) is data, not an exception — it is returned to the
 * caller unretried, so callers honour the "never retry a 409" rule.
 *
 * Throws `WriteBudgetExhaustedError` once the budget (or the attempt backstop) is
 * spent. Any non-lock error propagates immediately, on the first attempt.
 */
export function withWriteRetry<T>(fn: () => T, opts: WriteRetryOptions = {}): T {
  // `performance.now()` is monotonic since process start — a Date.now() deadline
  // is exactly the kind of window an NTP step distorts.
  const now = opts.now ?? ((): number => performance.now())
  const sleep = opts.sleep ?? sleepSync
  const budgetMs = opts.budgetMs ?? resolveBudgetMs()
  const attemptCap = opts.attemptCap ?? RETRY_ATTEMPT_CAP
  const startedAt = now()
  let attempts = 0

  for (;;) {
    attempts += 1
    try {
      return fn()
    } catch (err) {
      if (!isBusyError(err)) throw err
      const elapsedMs = now() - startedAt
      const remaining = budgetMs - elapsedMs
      if (remaining <= 0 || attempts >= attemptCap) {
        throw new WriteBudgetExhaustedError({ attempts, budgetMs, elapsedMs, cause: err })
      }
      // Clamp the last sleep to what is left so the loop never overshoots the
      // deadline by a whole jitter interval.
      sleep(Math.min(jitterMs(), remaining))
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
