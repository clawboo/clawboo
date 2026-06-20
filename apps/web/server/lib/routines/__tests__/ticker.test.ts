// The Routines ticker against a REAL sqlite ledger, driven by a FAKE clock +
// manual tick() — zero wall-clock waits. Proves: due fires exactly once,
// paused never fires, error halts, once@ self-disables, recurrence re-arms,
// two tickers racing one row dispatch exactly once (the atomic claim), and
// boot-resume reconstructs the actuator from SQLite alone.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createDb,
  getScheduledRun,
  listEvents,
  markRunRunning,
  claimScheduledRun,
  queueDueRuns,
  registerScheduledRun,
  setScheduledRunStatus,
  type ClawbooDb,
  type DbScheduledRun,
} from '@clawboo/db'

import { createRoutinesTicker, type RoutinesTickerDeps } from '../ticker'

let dir: string
let db: ClawbooDb

const noopLog = { info: () => {}, error: () => {} }

function register(overrides: Partial<Parameters<typeof registerScheduledRun>[1]> = {}) {
  const result = registerScheduledRun(db, {
    agentId: 'agent-1',
    teamId: 'team-1',
    cronSpec: '* * * * *',
    taskTemplate: JSON.stringify({ title: 'Tick chore', kind: 'research', priority: 0 }),
    nextRunAt: 1_000,
    ...overrides,
  })
  if (!result.ok) throw new Error(`register failed: ${result.reason}`)
  return result.run
}

function makeTicker(deps: Partial<RoutinesTickerDeps> & { now: () => number }) {
  const dispatched: DbScheduledRun[] = []
  const ticker = createRoutinesTicker({
    db,
    log: noopLog,
    dispatch: deps.dispatch ?? (async (run) => (dispatched.push(run), { ok: true, taskId: 't-1' })),
    ...deps,
  })
  return { ticker, dispatched }
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-ticker-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('routines ticker', () => {
  it('fires a due routine exactly once, re-arms it, and emits the obs pair', async () => {
    const run = register({ nextRunAt: 1_000 })
    const now = Date.parse('2026-06-10T12:00:30.000Z')
    const { ticker, dispatched } = makeTicker({ now: () => now })

    expect((await ticker.tick()).fired).toBe(1)
    expect(dispatched.map((r) => r.id)).toEqual([run.id])

    const after = getScheduledRun(db, run.id)
    expect(after?.status).toBe('idle')
    expect(after?.lastRunAt).toBe(now)
    expect(after?.nextRunAt).toBeGreaterThan(now) // '* * * * *' re-armed

    // Not due again at the same instant.
    expect((await ticker.tick()).fired).toBe(0)
    expect(dispatched).toHaveLength(1)

    const kinds = listEvents(db).map((e) => e.kind)
    expect(kinds).toContain('routine_fired')
    expect(kinds).toContain('routine_completed')
  })

  it('paused routines never fire even when long overdue', async () => {
    const run = register({ nextRunAt: 1_000 })
    expect(setScheduledRunStatus(db, run.id, 'paused').ok).toBe(true)
    const { ticker, dispatched } = makeTicker({ now: () => 999_999_999 })
    expect((await ticker.tick()).fired).toBe(0)
    expect(dispatched).toHaveLength(0)
  })

  it('a failed dispatch parks the routine in error (disarmed) and emits routine_error', async () => {
    const run = register({ nextRunAt: 1_000 })
    const { ticker } = makeTicker({
      now: () => 2_000,
      dispatch: async () => ({ ok: false, error: 'gateway exploded' }),
    })
    await ticker.tick()
    expect(getScheduledRun(db, run.id)).toMatchObject({
      status: 'error',
      lastError: 'gateway exploded',
      nextRunAt: null,
    })
    // Halted: the next tick fires nothing.
    expect((await ticker.tick()).fired).toBe(0)
    expect(listEvents(db).map((e) => e.kind)).toContain('routine_error')
  })

  it('a THROWING dispatch is caught and recorded as the outcome error', async () => {
    const run = register({ nextRunAt: 1_000 })
    const { ticker } = makeTicker({
      now: () => 2_000,
      dispatch: async () => {
        throw new Error('human-participant Routines are not implemented yet')
      },
    })
    await ticker.tick()
    expect(getScheduledRun(db, run.id)?.lastError).toContain('not implemented')
  })

  it('a one-shot (once@) self-disables after a successful fire', async () => {
    const fireAt = Date.parse('2026-07-01T09:00:00.000Z')
    const run = register({ cronSpec: 'once@2026-07-01T09:00:00.000Z', nextRunAt: fireAt })
    const { ticker, dispatched } = makeTicker({ now: () => fireAt + 1 })
    expect((await ticker.tick()).fired).toBe(1)
    expect(getScheduledRun(db, run.id)).toMatchObject({ status: 'idle', nextRunAt: null })
    expect((await ticker.tick()).fired).toBe(0)
    expect(dispatched).toHaveLength(1)
  })

  it('TWO tickers racing the SAME due row over one db dispatch exactly once', async () => {
    register({ nextRunAt: 1_000 })
    let dispatches = 0
    const slowDispatch = async () => {
      // Yield so both ticks interleave around the claim.
      await new Promise((resolve) => setImmediate(resolve))
      dispatches += 1
      return { ok: true as const, taskId: 't-1' }
    }
    const a = createRoutinesTicker({ db, log: noopLog, now: () => 2_000, dispatch: slowDispatch })
    const b = createRoutinesTicker({ db, log: noopLog, now: () => 2_000, dispatch: slowDispatch })
    const [ra, rb] = await Promise.all([a.tick(), b.tick()])
    expect(dispatches).toBe(1)
    expect(ra.fired + rb.fired).toBe(1)
  })

  it('BOOT-RESUME: a fresh ticker reconstructs everything from SQLite alone', async () => {
    // Simulate a crashed server: one claimed orphan, one running recurring
    // orphan, one running once@ orphan — no in-memory carry-over anywhere.
    const claimed = register({ nextRunAt: 1_000 })
    queueDueRuns(db, 2_000)
    claimScheduledRun(db, claimed.id)

    const runningRecurring = register({ nextRunAt: 1_000 })
    queueDueRuns(db, 2_000)
    claimScheduledRun(db, runningRecurring.id)
    markRunRunning(db, runningRecurring.id)

    const runningOnce = register({ cronSpec: 'once@2026-07-01T09:00:00Z', nextRunAt: 1_000 })
    queueDueRuns(db, 2_000)
    claimScheduledRun(db, runningOnce.id)
    markRunRunning(db, runningOnce.id)

    const now = Date.parse('2026-06-10T12:00:30.000Z')
    const { ticker, dispatched } = makeTicker({ now: () => now })
    ticker.bootResume()
    await ticker.tick()

    // The claimed orphan was requeued and FIRED on the first tick.
    expect(dispatched.map((r) => r.id)).toEqual([claimed.id])
    // The recurring running orphan was re-armed to a future occurrence.
    const recurring = getScheduledRun(db, runningRecurring.id)
    expect(recurring?.status).toBe('idle')
    expect(recurring?.nextRunAt).toBeGreaterThan(now)
    // The once@ orphan was parked (never double-materialize a one-shot).
    expect(getScheduledRun(db, runningOnce.id)?.status).toBe('error')
  })

  it('a future routine fires once the fake clock passes nextRunAt', async () => {
    const fireAt = 50_000
    register({ nextRunAt: fireAt })
    let now = 10_000
    const { ticker, dispatched } = makeTicker({ now: () => now })
    expect((await ticker.tick()).fired).toBe(0)
    now = fireAt + 1
    expect((await ticker.tick()).fired).toBe(1)
    expect(dispatched).toHaveLength(1)
  })

  it('dispatches due routines CONCURRENTLY — a slow fire does not head-of-line-block a fast one', async () => {
    const slow = register({ agentId: 'agent-slow', nextRunAt: 1_000 })
    register({ agentId: 'agent-fast', nextRunAt: 1_000 })
    let releaseSlow: (() => void) | null = null
    const slowGate = new Promise<void>((r) => {
      releaseSlow = r
    })
    const completed: string[] = []
    const dispatch = async (run: DbScheduledRun) => {
      if (run.id === slow.id) {
        await slowGate
        completed.push('slow')
      } else {
        completed.push('fast')
      }
      return { ok: true as const, taskId: 't' }
    }
    const now = Date.parse('2026-06-10T12:00:30.000Z')
    const { ticker } = makeTicker({ now: () => now, dispatch })

    const tickPromise = ticker.tick()
    await new Promise((r) => setTimeout(r, 25)) // let the fast fire settle
    // Sequential dispatch would block the fast fire behind the (gated) slow one.
    expect(completed).toContain('fast')
    expect(completed).not.toContain('slow')

    releaseSlow!()
    const { fired } = await tickPromise
    expect(fired).toBe(2)
    expect(completed).toEqual(['fast', 'slow']) // fast finished first
  })
})
