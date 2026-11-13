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
// without the index cross-check, at about a tenth of the cost. The full
// `integrity_check` runs when a person re-runs the probe, and in the background
// once a day (see bootProbe).
//
// It never falls back to the main thread. When the worker cannot run the check
// (the driver does not load, the file cannot be opened, another connection keeps
// it busy, it runs out of time), the result says the check could not run, which
// says nothing about the database either way.

import { createRequire } from 'node:module'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

export type DbCheckKind = 'quick_check' | 'integrity_check'

/** How long each check may take before it counts as not run. Generous: the full
 *  check reads every page and every index of a large database. */
export const DB_CHECK_TIMEOUT_MS: Record<DbCheckKind, number> = {
  quick_check: 2 * 60_000,
  integrity_check: 15 * 60_000,
}

/**
 * `ran`: SQLite gave its verdict, 'ok' when nothing is wrong, else what is (its
 * first row, or the corruption error that stopped the check). `not-run`: the check
 * could not run, for `reason`.
 */
export type DbCheckResult = { ran: true; verdict: string } | { ran: false; reason: string }

/** The worker's whole program. Eval'd, so the driver comes in by absolute path. */
const WORKER_SOURCE = `
const { parentPort, workerData } = require('node:worker_threads')
// SQLite stops on some damage with an error, and that error is the verdict. Any
// other error (busy, locked, out of memory, an I/O error, no driver) means the
// check did not run.
const damage = (err) => {
  const code = String((err && err.code) || '')
  return code.startsWith('SQLITE_CORRUPT') || code === 'SQLITE_NOTADB'
}
const text = (err) => String((err && err.message) || err)
let db = null
let message = null
try {
  const Database = require(workerData.driver)
  db = new Database(workerData.file, { readonly: true, fileMustExist: true })
  db.pragma('busy_timeout = 5000')
  const rows = db.pragma(workerData.kind)
  message = { ran: true, verdict: rows.length > 0 ? String(Object.values(rows[0])[0]) : 'unknown' }
} catch (err) {
  message = damage(err) ? { ran: true, verdict: text(err) } : { ran: false, reason: text(err) }
}
try { if (db) db.close() } catch (_) {}
parentPort.postMessage(message)
`

function driverPath(): string {
  // Resolved from this module's own folder, which in the published package is
  // next to its node_modules; never from the process's working directory.
  return createRequire(path.join(__dirname, 'noop.js')).resolve('better-sqlite3')
}

/** Run `kind` against the database file in a worker thread. Never throws. */
export function checkDatabase(
  file: string,
  kind: DbCheckKind,
  opts: { timeoutMs?: number } = {},
): Promise<DbCheckResult> {
  let worker: Worker
  try {
    worker = new Worker(WORKER_SOURCE, {
      eval: true,
      workerData: { driver: driverPath(), file, kind },
    })
  } catch (err) {
    return Promise.resolve({
      ran: false,
      reason: `no worker thread: ${err instanceof Error ? err.message : String(err)}`,
    })
  }
  const timeoutMs = opts.timeoutMs ?? DB_CHECK_TIMEOUT_MS[kind]
  return new Promise<DbCheckResult>((resolve) => {
    let settled = false
    const settle = (result: DbCheckResult): void => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }
    const timer = setTimeout(() => {
      settle({ ran: false, reason: `timed out after ${Math.round(timeoutMs / 1000)} s` })
      void worker.terminate().catch(() => undefined)
    }, timeoutMs)
    timer.unref?.()
    worker.once('message', (msg: DbCheckResult) => {
      settle(
        msg && msg.ran === true && typeof msg.verdict === 'string'
          ? { ran: true, verdict: msg.verdict }
          : { ran: false, reason: msg && msg.ran === false ? msg.reason : 'no answer' },
      )
    })
    worker.once('error', (err: Error) => settle({ ran: false, reason: err.message }))
    worker.once('exit', (code) => settle({ ran: false, reason: `the worker exited (${code})` }))
    // A worker must never keep the process alive on its own.
    worker.unref()
  })
}
