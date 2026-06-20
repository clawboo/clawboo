// Worker for the real-concurrency contention test. Runs as a separate thread
// with its OWN better-sqlite3 connection to the shared DB file, so the
// WAL + busy_timeout + jittered-retry recipe is genuinely exercised.
//
// Imports the BUILT @clawboo/db (a worker gets no vitest/TS transform), so the
// gated test recipe builds the package first.
import { parentPort, workerData } from 'node:worker_threads'

async function main() {
  const { dbPath, taskId, id, iters, mode } = workerData
  const db = await import('@clawboo/db')
  const conn = db.createDb(dbPath)

  // `claim` mode: race a SINGLE atomic claimTask on ONE task against the other
  // threads — the exactly-one-winner mutex under true OS-thread concurrency (the
  // `addComment` mode below only proves WAL write-survival, not the claim mutex).
  if (mode === 'claim') {
    const r = db.claimTask(conn, taskId, `agent-w${id}`)
    parentPort.postMessage({ id, claimed: Boolean(r.ok), reason: r.reason ?? null })
    return
  }

  let locked = 0
  for (let i = 0; i < iters; i += 1) {
    try {
      db.addComment(conn, taskId, `w${id}-${i}`, 'system')
    } catch (e) {
      const msg = String(e && e.message ? e.message : e)
      if (/database is locked|SQLITE_BUSY/i.test(msg)) locked += 1
      else throw e
    }
  }
  parentPort.postMessage({ id, locked })
}

main().catch((e) => {
  parentPort.postMessage({ error: String(e && e.message ? e.message : e) })
})
