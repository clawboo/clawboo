// SQLite's own corruption checks, off the main thread.
//
// `PRAGMA integrity_check` reads every page and cross-checks every index: about
// 6 to 10 seconds on a database of several hundred MB, and better-sqlite3 runs it
// synchronously. Run on the server's own connection it froze the event loop right
// after the port opened, so the first requests (a person opening the dashboard, a
// host checking the engine it just woke) waited behind it. On a host that stops
// the engine when idle and starts it on demand, that was every wake.
//
// So the check runs in a worker thread on a read-only connection of its own (the
// database is in WAL mode, so a reader sees one consistent snapshot while the
// server writes). At boot it is `quick_check`: the same page and b-tree checks,
// without the index cross-check, at about a tenth of the cost. A person's "Re-run
// probe" asks for the full `integrity_check`. If the worker cannot start, the
// check runs on the given connection as before.

import { createRequire } from 'node:module'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

import { type ClawbooDb } from '@clawboo/db'
import { sql } from 'drizzle-orm'

export type DbCheckKind = 'quick_check' | 'integrity_check'

/** The worker's whole program. Eval'd, so the driver comes in by absolute path. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
let db = null
try {
  const Database = require(workerData.driver)
  db = new Database(workerData.file, { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 5000')
} catch (err) {
  // The check never started, so this says nothing about the database.
  parentPort.postMessage({ ok: false, error: String((err && err.message) || err) })
  db = null
}
if (db) {
  let message
  try {
    const rows = db.pragma(workerData.kind)
    message = { ok: true, verdict: rows.length > 0 ? String(Object.values(rows[0])[0]) : 'unknown' }
  } catch (err) {
    const code = String((err && err.code) || '')
    message = code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB'
      // SQLite stops the check with an error on some damage: that error is the verdict.
      ? { ok: true, verdict: String((err && err.message) || err) }
      // Anything else (busy, locked, out of memory, an I/O error) means the check
      // did not run here, so it says nothing about the database.
      : { ok: false, error: String((err && err.message) || err) }
  }
  try { db.close() } catch (_) {}
  parentPort.postMessage(message)
}
`

/** The check on the calling thread: SQLite's first row, 'ok' when nothing is wrong. */
export function checkDatabaseInThread(db: ClawbooDb, kind: DbCheckKind): string {
  const rows = db.all(sql.raw(`PRAGMA ${kind}`)) as Array<Record<string, unknown>>
  // The pragma always yields at least one row ('ok' or what is wrong); none means
  // it did not run normally, which is a failure, not health.
  if (rows.length === 0) return 'unknown'
  return String(Object.values(rows[0]!)[0] ?? 'unknown')
}

function driverPath(): string {
  // Resolved from this module's own folder, which in the published package is
  // next to its node_modules; never from the process's working directory.
  return createRequire(path.join(__dirname, 'noop.js')).resolve('better-sqlite3')
}

export interface DbCheckResult {
  /** SQLite's first row: 'ok' when nothing is wrong, else what is. */
  verdict: string
  /** False when the worker could not run and the check ran on the calling thread. */
  offThread: boolean
}

/**
 * Run `kind` against the database file in a worker thread and resolve with
 * SQLite's verdict. Falls back to the given connection, on this thread, when the
 * worker cannot run.
 */
export function checkDatabase(
  db: ClawbooDb,
  file: string,
  kind: DbCheckKind,
): Promise<DbCheckResult> {
  const inThread = (): DbCheckResult => ({
    verdict: checkDatabaseInThread(db, kind),
    offThread: false,
  })
  let worker: Worker
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { driver: driverPath(), file, kind },
    })
  } catch {
    return Promise.resolve(inThread())
  }
  return new Promise<DbCheckResult>((resolve) => {
    let settled = false
    const fallBack = (): void => {
      if (settled) return
      settled = true
      try {
        resolve(inThread())
      } catch (err) {
        resolve({ verdict: err instanceof Error ? err.message : String(err), offThread: false })
      }
    }
    worker.once('message', (msg: { ok: boolean; verdict?: string }) => {
      if (settled) return
      if (msg.ok && typeof msg.verdict === 'string') {
        settled = true
        resolve({ verdict: msg.verdict, offThread: true })
      } else {
        // The worker could not open the file or load the driver: the check itself
        // never ran, so it says nothing about the database. Run it here instead.
        fallBack()
      }
    })
    worker.once('error', fallBack)
    worker.once('exit', fallBack)
    // A worker must never keep the process alive on its own.
    worker.unref()
  })
}
