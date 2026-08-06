import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Worker } from 'node:worker_threads'

import { describe, expect, it } from 'vitest'

import { createDb } from '../../db'
import { createTask, listTasks } from '../repository'

// Gated: real OS-thread contention needs the BUILT dist (a Worker gets no TS
// transform), so this is skipped in the default `pnpm test`. Run it with:
//   pnpm --filter @clawboo/db build && \
//   CLAWBOO_CONCURRENCY_TEST=1 pnpm --filter @clawboo/db test
const ENABLED = process.env['CLAWBOO_CONCURRENCY_TEST'] === '1'
const WORKERS = 20
const ITERS = 50

// __dirname is provided by vitest for this CommonJS package.
const workerPath = path.join(__dirname, 'board.contention.worker.mjs')

function runWorker(dbPath: string, taskId: string, id: number): Promise<{ locked: number }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerPath, { workerData: { dbPath, taskId, id, iters: ITERS } })
    w.once('message', (m: { locked?: number; error?: string }) => {
      if (m.error) reject(new Error(m.error))
      else resolve({ locked: m.locked ?? 0 })
    })
    w.once('error', reject)
  })
}

function runClaimWorker(
  dbPath: string,
  taskId: string,
  id: number,
): Promise<{ claimed: boolean; reason: string | null }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerPath, { workerData: { dbPath, taskId, id, mode: 'claim' } })
    w.once('message', (m: { claimed?: boolean; reason?: string | null; error?: string }) => {
      if (m.error) reject(new Error(m.error))
      else resolve({ claimed: Boolean(m.claimed), reason: m.reason ?? null })
    })
    w.once('error', reject)
  })
}

function runChildWorker(
  dbPath: string,
  taskId: string,
  id: number,
  maxChildren: number,
  startAtMs: number,
): Promise<{ created: boolean; reason: string | null }> {
  return new Promise((resolve, reject) => {
    const w = new Worker(workerPath, {
      workerData: { dbPath, taskId, id, mode: 'child', maxChildren, startAtMs },
    })
    w.once('message', (m: { created?: boolean; reason?: string | null; error?: string }) => {
      if (m.error) reject(new Error(m.error))
      else resolve({ created: Boolean(m.created), reason: m.reason ?? null })
    })
    w.once('error', reject)
  })
}

describe.skipIf(!ENABLED)('write contention (real concurrency)', () => {
  it(`${WORKERS} concurrent writers complete with zero "database is locked"`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-contention-'))
    const dbPath = path.join(dir, 'test.db')
    try {
      const db = createDb(dbPath)
      const task = createTask(db, { title: 'contended', teamId: 'team1' })
      const results = await Promise.all(
        Array.from({ length: WORKERS }, (_, i) => runWorker(dbPath, task.id, i)),
      )
      const totalLocked = results.reduce((acc, r) => acc + r.locked, 0)
      expect(totalLocked).toBe(0)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it(`exactly one of ${WORKERS} concurrent claimTask calls wins; the rest get a conflict (no double-claim)`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-claim-race-'))
    const dbPath = path.join(dir, 'test.db')
    try {
      const db = createDb(dbPath)
      const task = createTask(db, { title: 'claim me', teamId: 'team1' })
      // N threads each fire ONE atomic claim on the SAME task simultaneously.
      const results = await Promise.all(
        Array.from({ length: WORKERS }, (_, i) => runClaimWorker(dbPath, task.id, i)),
      )
      const winners = results.filter((r) => r.claimed)
      const losers = results.filter((r) => !r.claimed)
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(WORKERS - 1)
      expect(losers.every((r) => r.reason === 'conflict')).toBe(true)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)

  it(`${WORKERS} concurrent capped-subtask creates land exactly MAX children (no cap overrun)`, async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-child-cap-'))
    const dbPath = path.join(dir, 'test.db')
    const MAX = 5
    try {
      const db = createDb(dbPath)
      const parent = createTask(db, { title: 'contended parent', teamId: 'team1' })
      // N threads each fire ONE capped create against the SAME parent. A naive
      // count → check → insert would let several past the ceiling at once; the
      // BEGIN IMMEDIATE transaction is what makes exactly MAX land.
      // Every thread is released on the SAME wall-clock instant (see the barrier
      // in the worker) so the count→insert windows genuinely overlap. The budget
      // covers 20 worker spawns plus the `@clawboo/db` import in each.
      const startAtMs = Date.now() + 3000
      const results = await Promise.all(
        Array.from({ length: WORKERS }, (_, i) =>
          runChildWorker(dbPath, parent.id, i, MAX, startAtMs),
        ),
      )
      expect(results.filter((r) => r.created)).toHaveLength(MAX)
      expect(results.filter((r) => !r.created).every((r) => r.reason === 'child_cap')).toBe(true)
      expect(listTasks(db).filter((t) => t.parentTaskId === parent.id)).toHaveLength(MAX)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  }, 60_000)
})
