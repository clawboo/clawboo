// A routine keeps its schedule through failures that may pass by themselves (a
// rate limit, a timeout, a provider outage), recording each one, and stops only
// on a failure a person must fix, or after MAX_ROUTINE_TRANSIENT_FAILURES in a
// row. Driven through the real ticker over a real sqlite ledger with a fake
// clock and an injected dispatch.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MAX_ROUTINE_TRANSIENT_FAILURES,
  createDb,
  deleteScheduledRun,
  getScheduledRun,
  listEvents,
  registerScheduledRun,
  type ClawbooDb,
} from '@clawboo/db'

import { createRoutinesTicker } from '../ticker'
import type { RoutineDispatchOutcome } from '../wakeBridge'

let dir: string
let db: ClawbooDb
const logged: { level: string; msg: string }[] = []
const log = {
  info: () => {},
  warn: (_o: object, msg: string) => void logged.push({ level: 'warn', msg }),
  error: (_o: object, msg: string) => void logged.push({ level: 'error', msg }),
}

const MINUTE = 60_000
const START = Date.parse('2026-06-10T12:00:30.000Z')

function register() {
  const result = registerScheduledRun(db, {
    agentId: 'agent-1',
    teamId: 'team-1',
    cronSpec: '* * * * *',
    taskTemplate: JSON.stringify({ title: 'Every minute', kind: 'research', priority: 0 }),
    nextRunAt: START - 1_000,
  })
  if (!result.ok) throw new Error(`register failed: ${result.reason}`)
  return result.run
}

/** A ticker whose dispatch answers with `outcomes` in turn. */
function tickerWith(outcomes: RoutineDispatchOutcome[], clock: { now: number }) {
  return createRoutinesTicker({
    db,
    log,
    now: () => clock.now,
    dispatch: async () => outcomes.shift() ?? { ok: true, taskId: null },
  })
}

function routineErrors(): Array<{ message: string; errorClass?: string; stopped?: boolean }> {
  return listEvents(db, { kinds: ['routine_error'], limit: 100 }).map(
    (e) => JSON.parse(e.data) as { message: string; errorClass?: string; stopped?: boolean },
  )
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-routine-failures-'))
  db = createDb(path.join(dir, 'test.db'))
  logged.length = 0
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('a routine and its failures', () => {
  it('rides out a failure that may pass: re-armed at its next time, the error recorded', async () => {
    const run = register()
    const clock = { now: START }
    const ticker = tickerWith(
      [
        {
          ok: false,
          error: 'Request rejected (HTTP 429)',
          errorClass: 'RateLimited',
          transient: true,
        },
      ],
      clock,
    )
    expect((await ticker.tick()).fired).toBe(1)
    const after = getScheduledRun(db, run.id)
    expect(after).toMatchObject({
      status: 'idle',
      lastError: 'Request rejected (HTTP 429)',
      failureStreak: 1,
    })
    expect(after?.nextRunAt).toBeGreaterThan(START)
    expect(routineErrors()).toEqual([
      expect.objectContaining({
        message: 'Request rejected (HTTP 429)',
        errorClass: 'RateLimited',
        stopped: false,
      }),
    ])
    expect(logged).toEqual([expect.objectContaining({ level: 'warn' })])
    // It fires again at its next time, and a success clears the record.
    clock.now = after!.nextRunAt! + 1
    expect((await ticker.tick()).fired).toBe(1)
    expect(getScheduledRun(db, run.id)).toMatchObject({
      status: 'idle',
      lastError: null,
      failureStreak: 0,
    })
  })

  it(`stops after ${MAX_ROUTINE_TRANSIENT_FAILURES} failures in a row that might have passed`, async () => {
    const run = register()
    const clock = { now: START }
    const blip: RoutineDispatchOutcome = {
      ok: false,
      error: 'Overloaded (HTTP 529)',
      errorClass: 'ProviderError',
      transient: true,
    }
    const ticker = tickerWith(
      Array.from({ length: MAX_ROUTINE_TRANSIENT_FAILURES }, () => ({ ...blip })),
      clock,
    )
    for (let i = 0; i < MAX_ROUTINE_TRANSIENT_FAILURES; i++) {
      expect((await ticker.tick()).fired).toBe(1)
      clock.now += MINUTE
    }
    expect(getScheduledRun(db, run.id)).toMatchObject({
      status: 'error',
      nextRunAt: null,
      failureStreak: MAX_ROUTINE_TRANSIENT_FAILURES,
    })
    expect(routineErrors().map((e) => e.stopped)).toEqual([
      ...Array.from({ length: MAX_ROUTINE_TRANSIENT_FAILURES - 1 }, () => false),
      true,
    ])
    // Parked: no further fires.
    clock.now += 10 * MINUTE
    expect((await ticker.tick()).fired).toBe(0)
  })

  it('stops a one-time routine that "Run now" fired early, even on a failure that may pass', async () => {
    // Its time is still a day ahead, so a re-arm would fire it again then.
    const result = registerScheduledRun(db, {
      agentId: 'agent-1',
      teamId: 'team-1',
      cronSpec: `once@${new Date(START + 24 * 60 * MINUTE).toISOString()}`,
      taskTemplate: JSON.stringify({ title: 'Once', kind: 'research', priority: 0 }),
      nextRunAt: START - 1_000,
    })
    if (!result.ok) throw new Error(`register failed: ${result.reason}`)
    const clock = { now: START }
    const ticker = tickerWith(
      [
        {
          ok: false,
          error: 'Request rejected (HTTP 429)',
          errorClass: 'RateLimited',
          transient: true,
        },
      ],
      clock,
    )
    expect((await ticker.tick()).fired).toBe(1)
    expect(getScheduledRun(db, result.run.id)).toMatchObject({ status: 'error', nextRunAt: null })
    expect(routineErrors()).toEqual([expect.objectContaining({ stopped: true })])
  })

  it('stops at once on a failure a person must fix', async () => {
    const run = register()
    const clock = { now: START }
    const ticker = tickerWith(
      [{ ok: false, error: 'Invalid API key (HTTP 401)', errorClass: 'Auth', transient: false }],
      clock,
    )
    await ticker.tick()
    expect(getScheduledRun(db, run.id)).toMatchObject({ status: 'error', nextRunAt: null })
    expect(routineErrors()).toEqual([
      expect.objectContaining({ errorClass: 'Auth', stopped: true }),
    ])
    expect(logged).toEqual([expect.objectContaining({ level: 'error' })])
  })

  it('keeps the state of a routine that moved on while its fire was failing', async () => {
    const run = register()
    const clock = { now: START }
    const ticker = createRoutinesTicker({
      db,
      log,
      now: () => clock.now,
      dispatch: async () => {
        deleteScheduledRun(db, run.id)
        return { ok: false, error: 'Overloaded', errorClass: 'ProviderError', transient: true }
      },
    })
    await ticker.tick()
    const [event] = routineErrors()
    expect(event).toMatchObject({ message: 'Overloaded', errorClass: 'ProviderError' })
    expect(event).not.toHaveProperty('stopped')
    expect(logged).toEqual([
      { level: 'warn', msg: expect.stringMatching(/moved on, so its state was kept/) },
    ])
  })
})
