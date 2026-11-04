// The Routines ticker under an engine hold: a held engine claims no due routine
// (the ledger keeps it as it was), its timer only rescans instead of spinning on
// a queued row, and the routine fires once the hold lifts. Real sqlite ledger,
// fake clock, manual tick().

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createDb,
  getScheduledRun,
  listEvents,
  queueRunNow,
  registerScheduledRun,
  type ClawbooDb,
  type DbScheduledRun,
} from '@clawboo/db'

import { createRoutinesTicker } from '../ticker'

let dir: string
let db: ClawbooDb

const noopLog = { info: () => {}, warn: () => {}, error: () => {} }

function register(nextRunAt: number): DbScheduledRun {
  const result = registerScheduledRun(db, {
    agentId: 'agent-1',
    teamId: 'team-1',
    cronSpec: '* * * * *',
    taskTemplate: JSON.stringify({ title: 'Tick chore', kind: 'research', priority: 0 }),
    nextRunAt,
  })
  if (!result.ok) throw new Error(`register failed: ${result.reason}`)
  return result.run
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-ticker-hold-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  vi.useRealTimers()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('routines ticker while the engine is held', () => {
  it('claims no due routine while held, and fires it once the hold lifts', async () => {
    const run = register(1_000)
    let held = true
    const dispatched: string[] = []
    const ticker = createRoutinesTicker({
      db,
      log: noopLog,
      now: () => 2_000,
      held: () => held,
      dispatch: async (r) => (dispatched.push(r.id), { ok: true, taskId: 't-1' }),
    })

    expect((await ticker.tick()).fired).toBe(0)
    expect(dispatched).toEqual([])
    // Nothing claimed and nothing written: the row is exactly as it was.
    const during = getScheduledRun(db, run.id)
    expect(during?.status).toBe('idle')
    expect(during?.nextRunAt).toBe(1_000)
    expect(listEvents(db).map((e) => e.kind)).not.toContain('routine_fired')

    held = false
    expect((await ticker.tick()).fired).toBe(1)
    expect(dispatched).toEqual([run.id])
  })

  it('keeps a Run now queued through the hold without spinning, then fires it on the rescan', async () => {
    vi.useFakeTimers()
    const run = register(4_000_000_000_000)
    let held = true
    let reads = 0
    const dispatched: string[] = []
    const ticker = createRoutinesTicker({
      db,
      log: noopLog,
      now: () => 1_000_000,
      held: () => (reads++, held),
      dispatch: async (r) => (dispatched.push(r.id), { ok: true, taskId: 't-1' }),
    })
    ticker.start()
    expect(queueRunNow(db, run.id)).toBe(true)
    ticker.requestRescan()

    // Unheld, a queued row re-arms at 0 ms. Held, the ticker waits out the
    // rescan interval instead, so half a minute passes with no tick at all.
    reads = 0
    await vi.advanceTimersByTimeAsync(30_000)
    expect(dispatched).toEqual([])
    expect(getScheduledRun(db, run.id)?.status).toBe('queued')
    expect(reads).toBe(0)

    // What the hold's lift does in the server: ask for a rescan.
    held = false
    ticker.requestRescan()
    await vi.advanceTimersByTimeAsync(5)
    expect(dispatched).toEqual([run.id])
    ticker.stop()
  })
})
