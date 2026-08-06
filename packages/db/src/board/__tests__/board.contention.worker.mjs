// Worker for the real-concurrency contention test. Runs as a separate thread
// with its OWN better-sqlite3 connection to the shared DB file, so the
// WAL + busy_timeout + jittered-retry recipe is genuinely exercised.
//
// Imports the BUILT @clawboo/db (a worker gets no vitest/TS transform), so the
// gated test recipe builds the package first.
import { parentPort, workerData } from 'node:worker_threads'

async function main() {
  const { dbPath, taskId, id, iters, mode, maxChildren, startAtMs } = workerData
  const db = await import('@clawboo/db')
  const conn = db.createDb(dbPath)

  // `child` mode: race ONE capped-subtask create per thread against the SAME
  // parent — proves the count-then-insert is atomic across connections, so the
  // per-parent cap cannot be overrun exactly when a runaway loop is hammering it.
  if (mode === 'child') {
    // Release BARRIER, and it is load-bearing. Worker spawn + the `@clawboo/db`
    // import above cost tens of ms each, which serialises the threads: every
    // count would read a state the previous thread had already committed, and the
    // test would pass even against a NON-transactional count-then-insert. Parking
    // every thread on one shared wall-clock instant (they have all booted and
    // imported by then) is what makes the count→insert windows actually overlap.
    // Verified: with the count moved outside the transaction this assertion fails;
    // without the barrier it passes either way.
    if (typeof startAtMs === 'number') {
      const coarse = startAtMs - Date.now() - 20
      // `Atomics.wait`, not `setTimeout`: the same synchronous-sleep recipe
      // `contention.ts` uses for its retry jitter, and it needs no host globals in
      // a bare worker module.
      if (coarse > 0) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, coarse)
      while (Date.now() < startAtMs) {
        // final spin, so all threads leave within ~1 ms of each other
      }
    }
    const r = db.createCappedSubtask(conn, taskId, { title: `w${id}` }, { maxChildren })
    parentPort.postMessage({ id, created: Boolean(r.ok), reason: r.reason ?? null })
    return
  }

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
