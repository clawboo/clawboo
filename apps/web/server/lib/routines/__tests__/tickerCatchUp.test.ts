// Routines after the computer was stopped or asleep: a routine whose time passed
// fires ONCE when the engine runs again, never once per missed slot and never not
// at all. A due OpenClaw routine waits for the Gateway to connect instead of
// failing on it. And routinesDue answers when the next routine is due with the
// ticker's own rules. Real sqlite ledger; a fake clock for the restart cases and
// the sinon clock's jump for the sleep case (setSystemTime would move the armed
// timer too, so it could not show the timer firing on wake).

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agents,
  claimScheduledRun,
  createDb,
  getScheduledRun,
  markRunRunning,
  placePause,
  queueRunNow,
  registerScheduledRun,
  setScheduledRunStatus,
  setSetting,
  teams,
  type ClawbooDb,
  type DbScheduledRun,
} from '@clawboo/db'

import { GATEWAY_WAIT_MS, type GatewayState } from '../gatewayWait'
import { createRoutinesTicker, routinesDue, type RoutinesTickerDeps } from '../ticker'
import { SCHEDULER_TIME_ZONE_KEY } from '../timeZone'

let dir: string
let db: ClawbooDb

const noopLog = { info: () => {}, warn: () => {}, error: () => {} }
const HOUR = 3_600_000
const DAY = 24 * HOUR
/** Monday 2026-06-08, 09:00 UTC: the daily routine's slot. */
const MON_9AM = Date.parse('2026-06-08T09:00:00.000Z')

function register(overrides: Partial<Parameters<typeof registerScheduledRun>[1]> = {}) {
  const result = registerScheduledRun(db, {
    agentId: 'agent-1',
    teamId: 'team-1',
    cronSpec: '0 9 * * *',
    taskTemplate: JSON.stringify({ title: 'Daily report', kind: 'research', priority: 0 }),
    nextRunAt: MON_9AM,
    ...overrides,
  })
  if (!result.ok) throw new Error(`register failed: ${result.reason}`)
  return result.run
}

function makeTicker(deps: Partial<RoutinesTickerDeps>) {
  const dispatched: DbScheduledRun[] = []
  const ticker = createRoutinesTicker({
    db,
    log: noopLog,
    held: () => false,
    dispatch: async (run) => (dispatched.push(run), { ok: true, taskId: 't-1' }),
    ...deps,
  })
  return { ticker, dispatched }
}

function insertAgent(id: string, runtime: string, teamId: string | null = null): void {
  const now = Date.now()
  db.insert(agents)
    .values({
      id,
      name: id,
      gatewayId: id,
      sourceId: runtime,
      runtime,
      teamId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-ticker-catchup-'))
  db = createDb(path.join(dir, 'test.db'))
  setSetting(db, SCHEDULER_TIME_ZONE_KEY, 'UTC')
})

afterEach(() => {
  vi.useRealTimers()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('catch-up after the engine was stopped', () => {
  it('a daily routine that missed three slots fires once on start, then waits for the next slot', async () => {
    const run = register({ nextRunAt: MON_9AM })
    // Started again on Wednesday at 11:00: Monday, Tuesday and Wednesday 09:00 all passed.
    const wake = MON_9AM + 2 * DAY + 2 * HOUR
    const { ticker, dispatched } = makeTicker({ now: () => wake })

    ticker.bootResume()
    expect((await ticker.tick()).fired).toBe(1)
    expect((await ticker.tick()).fired).toBe(0)
    expect(dispatched.map((r) => r.id)).toEqual([run.id])
    // Re-armed from now: Thursday 09:00, not Tuesday's or Wednesday's missed slot.
    expect(getScheduledRun(db, run.id)?.nextRunAt).toBe(MON_9AM + 3 * DAY)
  })

  it('a one-time routine whose time passed while stopped fires once, then is spent', async () => {
    const at = MON_9AM
    const run = register({ cronSpec: `once@${new Date(at).toISOString()}`, nextRunAt: at })
    const { ticker, dispatched } = makeTicker({ now: () => at + 5 * DAY })

    ticker.bootResume()
    expect((await ticker.tick()).fired).toBe(1)
    expect((await ticker.tick()).fired).toBe(0)
    expect(dispatched).toHaveLength(1)
    expect(getScheduledRun(db, run.id)).toMatchObject({ status: 'idle', nextRunAt: null })
  })

  it('a paused routine stays unfired however many slots passed', async () => {
    const run = register({ nextRunAt: MON_9AM })
    expect(setScheduledRunStatus(db, run.id, 'paused').ok).toBe(true)
    const { ticker, dispatched } = makeTicker({ now: () => MON_9AM + 10 * DAY })

    ticker.bootResume()
    expect((await ticker.tick()).fired).toBe(0)
    expect(dispatched).toEqual([])
  })
})

describe('catch-up after the computer slept with the engine running', () => {
  it('the armed timer fires on wake and the routine runs once, re-armed after the wake', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    // Monday 08:59: the routine is a minute away when the lid closes.
    vi.setSystemTime(MON_9AM - 60_000)
    const run = register({ nextRunAt: MON_9AM })
    const { ticker, dispatched } = makeTicker({})
    ticker.start()

    // Asleep until Wednesday 11:00. The wall clock jumps and the armed timer, at most
    // a minute away, fires once after the wake.
    const clock = (globalThis.setTimeout as unknown as { clock: { jump(ms: number): void } }).clock
    clock.jump(2 * DAY + 2 * HOUR + 60_000)
    await vi.advanceTimersByTimeAsync(1)

    expect(dispatched.map((r) => r.id)).toEqual([run.id])
    expect(getScheduledRun(db, run.id)?.nextRunAt).toBe(MON_9AM + 3 * DAY)

    // Nothing more fires before Thursday 09:00.
    await vi.advanceTimersByTimeAsync(10 * 60_000)
    expect(dispatched).toHaveLength(1)
    ticker.stop()
  })
})

describe('a due OpenClaw routine waits for the Gateway', () => {
  function gateway(state: { configured: boolean; connected: boolean }): GatewayState {
    return { configured: () => state.configured, connected: () => state.connected }
  }

  it('stays queued while the Gateway is still connecting, and fires once it connects', async () => {
    insertAgent('oc', 'openclaw')
    const run = register({ agentId: 'oc', teamId: null, nextRunAt: MON_9AM })
    const state = { configured: true, connected: false }
    const wake = MON_9AM + DAY
    const { ticker, dispatched } = makeTicker({ now: () => wake, gateway: gateway(state) })

    ticker.bootResume()
    expect((await ticker.tick()).fired).toBe(0)
    expect(dispatched).toEqual([])
    expect(getScheduledRun(db, run.id)).toMatchObject({ status: 'queued', failureStreak: 0 })

    state.connected = true
    expect((await ticker.tick()).fired).toBe(1)
    expect(dispatched.map((r) => r.id)).toEqual([run.id])
  })

  it('stops waiting after GATEWAY_WAIT_MS, so a Gateway that never comes back still fails the fire', async () => {
    insertAgent('oc', 'openclaw')
    register({ agentId: 'oc', teamId: null, nextRunAt: MON_9AM })
    let now = MON_9AM + HOUR
    const { ticker, dispatched } = makeTicker({
      now: () => now,
      gateway: gateway({ configured: true, connected: false }),
    })

    expect((await ticker.tick()).fired).toBe(0)
    now += GATEWAY_WAIT_MS - 1
    expect((await ticker.tick()).fired).toBe(0)
    now += 1
    expect((await ticker.tick()).fired).toBe(1)
    expect(dispatched).toHaveLength(1)
  })

  it('does not wait when no Gateway is configured, or for an agent on another runtime', async () => {
    insertAgent('oc', 'openclaw')
    insertAgent('native', 'clawboo-native')
    register({ agentId: 'oc', teamId: null, nextRunAt: MON_9AM })
    register({ agentId: 'native', teamId: null, nextRunAt: MON_9AM })
    const noGateway = makeTicker({
      now: () => MON_9AM + HOUR,
      gateway: gateway({ configured: false, connected: false }),
    })
    expect((await noGateway.ticker.tick()).fired).toBe(2)
  })

  it('a native routine fires while an OpenClaw one waits', async () => {
    insertAgent('oc', 'openclaw')
    insertAgent('native', 'clawboo-native')
    const oc = register({ agentId: 'oc', teamId: null, nextRunAt: MON_9AM })
    const native = register({ agentId: 'native', teamId: null, nextRunAt: MON_9AM })
    const { ticker, dispatched } = makeTicker({
      now: () => MON_9AM + HOUR,
      gateway: gateway({ configured: true, connected: false }),
    })
    expect((await ticker.tick()).fired).toBe(1)
    expect(dispatched.map((r) => r.id)).toEqual([native.id])
    expect(getScheduledRun(db, oc.id)?.status).toBe('queued')
  })
})

describe('a due OpenClaw routine waits for the Gateway: the wait itself', () => {
  function gateway(state: { configured: boolean; connected: boolean }): GatewayState {
    return { configured: () => state.configured, connected: () => state.connected }
  }

  it('a team routine whose message goes to an OpenClaw lead waits too', async () => {
    db.insert(teams)
      .values({
        id: 'oc-team',
        name: 'OC team',
        icon: 'x',
        color: '#000',
        leaderAgentId: 'oc-lead',
        createdAt: 1,
        updatedAt: 1,
      })
      .run()
    insertAgent('oc-lead', 'openclaw', 'oc-team')
    const run = register({
      agentId: '',
      teamId: 'oc-team',
      taskTemplate: JSON.stringify({ title: 'Morning brief', target: 'team' }),
      nextRunAt: MON_9AM,
    })
    const state = { configured: true, connected: false }
    const { ticker, dispatched } = makeTicker({
      now: () => MON_9AM + HOUR,
      gateway: gateway(state),
    })
    expect((await ticker.tick()).fired).toBe(0)
    state.connected = true
    expect((await ticker.tick()).fired).toBe(1)
    expect(dispatched.map((r) => r.id)).toEqual([run.id])
  })

  it('a fire queued long ago still gets its full wait from when this server finds it', async () => {
    insertAgent('oc', 'openclaw')
    const run = register({ agentId: 'oc', teamId: null, nextRunAt: MON_9AM + 5 * DAY })
    // A Run now pressed long before this server started: the row has sat queued since.
    expect(queueRunNow(db, run.id, MON_9AM)).toBe(true)
    let now = MON_9AM + DAY
    const { ticker, dispatched } = makeTicker({
      now: () => now,
      gateway: gateway({ configured: true, connected: false }),
    })
    expect((await ticker.tick()).fired).toBe(0)
    now += GATEWAY_WAIT_MS - 1
    expect((await ticker.tick()).fired).toBe(0)
    now += 1
    expect((await ticker.tick()).fired).toBe(1)
    expect(dispatched).toHaveLength(1)
  })

  it('arms the timer for the moment the wait runs out, not the next minute rescan', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] })
    vi.setSystemTime(MON_9AM + HOUR)
    insertAgent('oc', 'openclaw')
    register({ agentId: 'oc', teamId: null, nextRunAt: MON_9AM })
    const { ticker, dispatched } = makeTicker({
      gateway: gateway({ configured: true, connected: false }),
    })
    ticker.start()
    await vi.advanceTimersByTimeAsync(1)
    // The due-pass queues the fire, and it starts to wait.
    await ticker.tick()
    // Shift the minute rescans off the wait's end, so only an arm at that moment fires it.
    await vi.advanceTimersByTimeAsync(10_000)
    ticker.requestRescan()
    await vi.advanceTimersByTimeAsync(GATEWAY_WAIT_MS - 10_000 - 2)
    expect(dispatched).toHaveLength(0)
    await vi.advanceTimersByTimeAsync(5)
    expect(dispatched).toHaveLength(1)
    ticker.stop()
  })
})

describe('routinesDue', () => {
  const NOW = MON_9AM - HOUR

  it('says nothing is due when no routine has a next run', () => {
    expect(routinesDue(db, NOW)).toEqual({ at: null, count: 0, inFlight: 0 })
  })

  it('names the earliest next run among armed routines', () => {
    register({ nextRunAt: MON_9AM + HOUR })
    register({ nextRunAt: MON_9AM })
    expect(routinesDue(db, NOW)).toEqual({ at: MON_9AM, count: 2, inFlight: 0 })
  })

  it('a routine whose time passed reads as its due time, which is before now', () => {
    register({ nextRunAt: NOW - DAY })
    expect(routinesDue(db, NOW).at).toBe(NOW - DAY)
  })

  it('a Run now reads as due now even with its next slot ahead', () => {
    const run = register({ nextRunAt: MON_9AM + 5 * DAY })
    expect(queueRunNow(db, run.id, NOW)).toBe(true)
    expect(routinesDue(db, NOW)).toEqual({ at: NOW, count: 1, inFlight: 0 })
  })

  it('leaves out paused routines, ones on an archived team, and ones a pause holds back', () => {
    const paused = register({ nextRunAt: MON_9AM })
    expect(setScheduledRunStatus(db, paused.id, 'paused').ok).toBe(true)

    db.insert(teams)
      .values({
        id: 'gone',
        name: 'Gone',
        icon: 'x',
        color: '#000',
        isArchived: 1,
        createdAt: 1,
        updatedAt: 1,
      })
      .run()
    register({ agentId: 'a-gone', teamId: 'gone', nextRunAt: MON_9AM })

    register({ agentId: 'held', teamId: null, nextRunAt: MON_9AM })
    placePause(db, { kind: 'agent', id: 'held' })

    expect(routinesDue(db, NOW)).toEqual({ at: null, count: 0, inFlight: 0 })
  })

  it('counts fires under way apart from what is due', () => {
    const run = register({ nextRunAt: NOW - 1 })
    expect(queueRunNow(db, run.id, NOW)).toBe(true)
    expect(claimScheduledRun(db, run.id, NOW)).not.toBeNull()
    expect(markRunRunning(db, run.id, NOW)).toBe(true)
    expect(routinesDue(db, NOW)).toEqual({ at: null, count: 0, inFlight: 1 })
  })
})
