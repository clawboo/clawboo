// The Routines ticker and a durable pause: a paused agent's or team's routine that
// falls due stays due, its timer does not spin on it, and it fires once on resume.
// Real sqlite ledger, fake clock, manual tick().

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createDb,
  getScheduledRun,
  liftPause,
  placePause,
  queueRunNow,
  registerScheduledRun,
  teams,
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

function tickerWith(dispatched: string[]) {
  return createRoutinesTicker({
    db,
    log: noopLog,
    now: () => 2_000,
    held: () => false,
    dispatch: async (r) => (dispatched.push(r.id), { ok: true, taskId: 't-1' }),
  })
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-ticker-pause-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  vi.useRealTimers()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('routines under a pause', () => {
  it('leaves a paused agent routine due, and fires it once on resume', async () => {
    const run = register(1_000)
    const dispatched: string[] = []
    const ticker = tickerWith(dispatched)

    placePause(db, { kind: 'agent', id: 'agent-1' })
    expect((await ticker.tick()).fired).toBe(0)
    expect(dispatched).toEqual([])
    expect(getScheduledRun(db, run.id)).toMatchObject({ status: 'idle', nextRunAt: 1_000 })

    liftPause(db, 'agent', 'agent-1')
    expect((await ticker.tick()).fired).toBe(1)
    expect(dispatched).toEqual([run.id])
  })

  it('leaves a paused team routine due too', async () => {
    register(1_000)
    const dispatched: string[] = []
    placePause(db, { kind: 'team', id: 'team-1' })
    expect((await tickerWith(dispatched).tick()).fired).toBe(0)
    expect(dispatched).toEqual([])
  })

  it('does not spin its timer on a due routine it may not fire', async () => {
    vi.useFakeTimers()
    register(1_000)
    placePause(db, { kind: 'agent', id: 'agent-1' })
    const dispatched: string[] = []
    const ticker = createRoutinesTicker({
      db,
      log: noopLog,
      now: () => 2_000,
      held: () => false,
      dispatch: async (r) => (dispatched.push(r.id), { ok: true, taskId: 't-1' }),
    })
    const queueSpy = vi.spyOn(db, 'update')
    ticker.start()
    // A minute of fake time: a delay of 0 would run this thousands of times.
    await vi.advanceTimersByTimeAsync(60_000)
    expect(queueSpy.mock.calls.length).toBeLessThan(5)
    ticker.stop()
  })

  it('holds a "Run now" row the same way, so a restart cannot fire it past the pause', async () => {
    const run = register(9_999_999)
    queueRunNow(db, run.id)
    placePause(db, { kind: 'agent', id: 'agent-1' })
    const dispatched: string[] = []
    expect((await tickerWith(dispatched).tick()).fired).toBe(0)
    expect(getScheduledRun(db, run.id)?.status).toBe('queued')
  })

  it('fires nothing for an archived team, and keeps the routine for when it comes back', async () => {
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'team-1',
        name: 'Old',
        icon: 'x',
        color: 'x',
        isArchived: 1,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const run = register(1_000)
    const dispatched: string[] = []
    expect((await tickerWith(dispatched).tick()).fired).toBe(0)
    expect(getScheduledRun(db, run.id)?.status).toBe('idle')
  })
})
