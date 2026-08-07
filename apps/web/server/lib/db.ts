// ─── The one connection ──────────────────────────────────────────────────────
// POLICY: server code never calls `createDb`/`openDb` directly and never closes
// the handle `getDb()` returns — not in a `finally`, not in `req.on('close')`,
// not in an SSE cleanup. The only closer is `closeDb()`, called once from the
// process-exit path. A handle opened at some OTHER path (a test fixture, the eval
// harness) is owned by whoever opened it and must be closed before its directory
// is removed. `sharedConnection.test.ts` enforces the first half of that.
//
// better-sqlite3 is synchronous, so ONE connection per process is not a
// bottleneck: writes already serialize on the single Node thread whether there is
// one handle or four hundred. What the old per-request open bought was a file
// open + WAL/shm mapping + an 88-statement schema bootstrap on every HTTP
// request, plus a leaked file descriptor on every path that forgot to close
// (which was nearly all of them).

import path from 'node:path'

import { resolveClawbooDir } from '@clawboo/config'
import { ensureSchema, openDb, type ClawbooDb } from '@clawboo/db'

export function getDbPath(): string {
  return path.join(resolveClawbooDir(), 'clawboo.db')
}

// Keyed by RESOLVED PATH rather than a bare singleton: `getDbPath()` follows
// `CLAWBOO_HOME` (and `$HOME`), which `resolveClawbooDir` re-reads on every call
// and which the server test suites re-point to a fresh sandbox per test. A plain
// singleton would hand test N+1 test N's database. Keying on the path makes the
// memo self-invalidating, so no test needs a reset hook. Production only ever has
// one key — exactly one connection for the process lifetime.
const handles = new Map<string, ClawbooDb>()

/**
 * The process-wide SQLite connection for the current `getDbPath()`. Opened and
 * schema-bootstrapped on first use (the server does that once at boot, see
 * `index.ts`); every later call is a Map hit.
 *
 * Never close what this returns — see `closeDb()`.
 */
export function getDb(): ClawbooDb {
  const dbPath = getDbPath()
  const existing = handles.get(dbPath)
  if (existing) return existing
  // A failure is deliberately NOT memoised: a transient open failure (home dir
  // not yet created, a permissions problem) must stay retryable, and the boot
  // probe reports it as a check outcome rather than wedging the server for its
  // whole lifetime.
  const db = openDb(dbPath)
  try {
    ensureSchema(db)
  } catch (err) {
    // The connection is already OPEN but not yet memoised, so neither `closeDb()`
    // nor `resetDb()` could ever reach it. Close it here: because the failure is
    // retryable by design, a caller that keeps retrying against a broken database
    // (`POST /api/health/recheck` is one) would otherwise leak a connection and an
    // fd per attempt — the exact thing this module exists to stop.
    try {
      db.$client.close()
    } catch {
      /* best-effort */
    }
    throw err
  }
  handles.set(dbPath, db)
  return db
}

/**
 * Checkpoint and close every open handle, then forget them. IDEMPOTENT by
 * construction, because the shutdown path runs twice: the `SIGINT` handler calls
 * it and then calls `process.exit(0)`, which fires the `'exit'` hook that calls it
 * again. Each entry is deleted BEFORE its close so a throwing close cannot leave a
 * dead handle memoised.
 *
 * The TRUNCATE checkpoint is defense-in-depth only — the WAL is crash-safe and
 * recovered on the next open — but it lets a naive single-file copy of
 * `clawboo.db` capture all recent committed writes without the WAL sidecars.
 * Never throws: a checkpoint failure must not change the exit code.
 */
export function closeDb(): void {
  for (const [key, db] of [...handles]) {
    handles.delete(key)
    try {
      db.$client.pragma('wal_checkpoint(TRUNCATE)')
    } catch {
      /* best-effort — the WAL is crash-safe without it */
    }
    try {
      db.$client.close()
    } catch {
      /* already closed */
    }
  }
}

/**
 * Test-only: drop the memo (closing the handles) without the shutdown checkpoint,
 * which is pure cost on a throwaway temp DB. Call it in `afterEach` BEFORE
 * removing the sandbox dir — Windows refuses to remove a directory that still
 * holds an open file. Mirrors `resetScheduleMultiplexer` / `resetMcpHandlers`.
 */
export function resetDb(): void {
  for (const [key, db] of [...handles]) {
    handles.delete(key)
    try {
      db.$client.close()
    } catch {
      /* already closed */
    }
  }
}
