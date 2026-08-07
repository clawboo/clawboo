import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { eq, sql } from 'drizzle-orm'
import { drizzle } from 'drizzle-orm/better-sqlite3'

import { noteConnectionOpened } from './openStats'
import * as schema from './schema'
import { settings } from './schema'
import type { DbSetting } from './schema'
import { ensureSchema } from './schemaBootstrap'

// ─── Database connection ───────────────────────────────────────────────────────

export type ClawbooDb = ReturnType<typeof drizzle<typeof schema>>

/**
 * How long SQLite itself waits for the write lock before handing control back to
 * the app-level jittered retry (`src/board/contention.ts`). Deliberately SHORT:
 * the busy handler is not the anti-convoy mechanism, the jittered retry is.
 * SQLite's handler wakes about a dozen times inside this window and re-takes the
 * lock the instant it frees, and a clawboo write is one sub-millisecond statement
 * or a small BEGIN IMMEDIATE — so a quarter second already absorbs a serialized
 * queue of hundreds of writers. Waiting a full second before backing off would
 * only make each LOSING writer hold its thread four times longer WITHOUT
 * decorrelating it from its rivals, and because the retry sleep is synchronous
 * that time is charged straight to the server's event loop.
 */
export const BUSY_TIMEOUT_MS = 250

/**
 * Resolve the canonical Clawboo SQLite path (`~/.openclaw/clawboo/clawboo.db`),
 * honouring a `CLAWBOO_DB_PATH` override. Shared so out-of-process consumers
 * (the MCP stdio bins spawned by external runtimes) open the SAME file the
 * Express server serves — the multi-process WAL recipe is what keeps that safe.
 */
export function defaultDbPath(): string {
  const override = process.env['CLAWBOO_DB_PATH']
  if (override && override.trim().length > 0) return override.trim()
  return path.join(os.homedir(), '.openclaw', 'clawboo', 'clawboo.db')
}

/**
 * Open a Clawboo SQLite connection at `dbPath` — mkdir + `new Database` + the
 * pragma recipe, and nothing else. It does NOT create tables: the caller owns
 * having run `ensureSchema` against this file (or calls `createDb`, which does
 * both).
 *
 * This is the seam a long-lived process uses. The Express server opens ONE
 * connection for its whole lifetime (`getDb()` in apps/web/server/lib/db.ts) and
 * bootstraps the schema once at boot. better-sqlite3 is synchronous, so a single
 * connection is not a bottleneck — writes already serialize on the one Node
 * thread whether there is one handle or four hundred.
 */
export function openDb(dbPath: string): ClawbooDb {
  const dir = path.dirname(dbPath)
  fs.mkdirSync(dir, { recursive: true })

  const sqlite = new Database(dbPath)

  // Performance + correctness pragmas
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  sqlite.pragma('synchronous = NORMAL')
  // Write-contention recipe: many agents — including the MCP stdio bins an
  // external runtime spawns out of process — may write one DB. Wait for the write
  // lock (dodges the SQLite "convoy effect"), and keep the WAL lean with a PASSIVE
  // autocheckpoint every ~50 pages. Paired with app-level jittered retry +
  // BEGIN IMMEDIATE in the board repository (see src/board/contention.ts).
  sqlite.pragma(`busy_timeout = ${BUSY_TIMEOUT_MS}`)
  sqlite.pragma('wal_autocheckpoint = 50')

  noteConnectionOpened()
  return drizzle(sqlite, { schema })
}

/**
 * Open AND bootstrap in one call — `openDb` followed by `ensureSchema`. This is
 * the right call for a process that opens one connection and exits: the four MCP
 * stdio bins, the eval harness, every test.
 *
 * Do NOT call it per request from a long-lived server. `ensureSchema` is
 * idempotent but not free (88 DDL statements re-resolved against `sqlite_master`
 * every time), and every open costs a file descriptor unless something closes it.
 * Use `getDb()` there instead — `sharedConnection.test.ts` fails the build if a
 * request path reintroduces either cost.
 */
export function createDb(dbPath: string): ClawbooDb {
  const db = openDb(dbPath)
  ensureSchema(db)
  return db
}

// ─── Settings helpers (typed key/value store) ─────────────────────────────────

export function getSetting(db: ClawbooDb, key: string): string | null {
  const row = db.select().from(settings).where(eq(settings.key, key)).get() as DbSetting | undefined
  return row?.value ?? null
}

export function setSetting(db: ClawbooDb, key: string, value: string): void {
  const now = Date.now()
  db.insert(settings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: now },
    })
    .run()
}

// ─── Boot-probe helpers (SQLite health) ───────────────────────────────────────

/**
 * Run `PRAGMA integrity_check` and return its single-row verdict ('ok' when the
 * file is healthy). Throwing here means the DB could not be queried at all — the
 * caller treats that as a fatal boot failure. A non-'ok' string is corruption.
 */
export function integrityCheck(db: ClawbooDb): string {
  const rows = db.all(sql`PRAGMA integrity_check`) as Array<{ integrity_check?: string }>
  // PRAGMA integrity_check always yields >=1 row ('ok' or error rows); zero rows
  // means the query did not execute normally — treat that as a failure, not healthy.
  if (rows.length === 0) return 'unknown'
  return rows[0]?.integrity_check ?? 'unknown'
}

/** List the user tables present in the DB (excludes sqlite_* internal tables). */
export function listTableNames(db: ClawbooDb): string[] {
  const rows = db.all(
    sql`SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'`,
  ) as Array<{ name: string }>
  return rows.map((r) => r.name)
}
