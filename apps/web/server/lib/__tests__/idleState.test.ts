// The idle answer's next due time across schedule sources: each source is ok, off
// or unknown, an unknown one makes the answer incomplete, and the earliest time
// any source named is the answer's time.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { engineIdleStateSchema } from '@clawboo/control-client'
import { createDb, registerScheduledRun, setSetting, type ClawbooDb } from '@clawboo/db'
import {
  SCHEDULE_SOURCE_NOT_CONFIGURED,
  type ScheduleReadResult,
  type ScheduleRecord,
  type ScheduleSource,
} from '@clawboo/scheduler'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { IDLE_SOURCE_READ_TIMEOUT_MS, buildIdleState } from '../idleState'
import { SCHEDULER_TIME_ZONE_KEY } from '../routines/timeZone'

let dir: string
let db: ClawbooDb
const NOW = Date.parse('2026-06-08T08:00:00.000Z')

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-idle-'))
  db = createDb(path.join(dir, 'test.db'))
  setSetting(db, SCHEDULER_TIME_ZONE_KEY, 'Europe/London')
})

afterEach(() => {
  vi.useRealTimers()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

function record(
  nextRunAt: number | null,
  status: ScheduleRecord['status'] = 'idle',
  cronSpec = '0 * * * *',
): ScheduleRecord {
  return {
    id: `openclaw-gateway-cron:${String(nextRunAt)}`,
    sourceScheduleId: String(nextRunAt),
    runtime: 'openclaw',
    owner: 'openclaw',
    source: 'openclaw-gateway-cron',
    agentId: 'oc',
    cronSpec,
    nextRunAt,
    status,
    manageability: 'external-write',
    domain: 'runtime-own-life',
    tenantId: null,
  }
}

function source(read: () => Promise<ScheduleReadResult>): ScheduleSource {
  return {
    id: 'openclaw-gateway-cron',
    domain: 'runtime-own-life',
    manageability: 'external-write',
    read,
    write: () => Promise.reject(new Error('read-only in this test')),
  }
}

const ok = (records: ScheduleRecord[]): ScheduleReadResult => ({
  records,
  status: { sourceId: 'openclaw-gateway-cron', ok: true, degraded: false, at: NOW },
})

function routine(nextRunAt: number): void {
  const result = registerScheduledRun(db, {
    agentId: 'agent-1',
    teamId: null,
    cronSpec: '0 9 * * *',
    taskTemplate: JSON.stringify({ title: 'Daily', kind: 'research', priority: 0 }),
    nextRunAt,
  })
  if (!result.ok) throw new Error(result.reason)
}

async function build(src: ScheduleSource, gatewayIsRemote = false) {
  const state = await buildIdleState({
    db,
    now: () => NOW,
    sources: () => [src],
    gatewayIsRemote: () => gatewayIsRemote,
  })
  // Whatever it says, it says it in the published shape.
  expect(engineIdleStateSchema.safeParse(state).success).toBe(true)
  return state
}

describe('idle answer: next due', () => {
  it('takes the earliest time across the routines and a readable Gateway', async () => {
    routine(NOW + 3_600_000)
    const state = await build(
      source(async () =>
        ok([
          record(NOW + 600_000, 'idle', '0 8 * * *@tz:America/New_York'),
          record(NOW + 900_000),
          record(NOW + 60_000, 'paused'),
          record(null),
        ]),
      ),
    )
    expect(state.nextDue).toEqual({
      at: NOW + 600_000,
      complete: true,
      timeZone: 'Europe/London',
      sources: [
        {
          id: 'clawboo-routine',
          state: 'ok',
          at: NOW + 3_600_000,
          count: 1,
          timeZone: 'Europe/London',
        },
        // The paused job and the one with no next run are not counted; the earliest
        // job names its own zone.
        {
          id: 'openclaw-gateway-cron',
          state: 'ok',
          at: NOW + 600_000,
          count: 2,
          timeZone: 'America/New_York',
        },
      ],
    })
  })

  it('reads a source that is not set up as off, with nothing due and the answer complete', async () => {
    routine(NOW + 3_600_000)
    const state = await build(
      source(async () => ({
        records: [],
        status: {
          sourceId: 'openclaw-gateway-cron',
          ok: false,
          degraded: true,
          reason: SCHEDULE_SOURCE_NOT_CONFIGURED,
          at: NOW,
        },
      })),
    )
    expect(state.nextDue.complete).toBe(true)
    expect(state.nextDue.at).toBe(NOW + 3_600_000)
    expect(state.nextDue.sources[1]).toEqual({
      id: 'openclaw-gateway-cron',
      state: 'off',
      at: null,
      count: 0,
      timeZone: null,
      reason: 'not_configured',
    })
  })

  it('reads a source in use but unreadable as unknown, keeps its last times, and marks the answer incomplete', async () => {
    const state = await build(
      source(async () => ({
        records: [record(NOW + 120_000)],
        status: {
          sourceId: 'openclaw-gateway-cron',
          ok: false,
          degraded: true,
          reason: 'stale_cache',
          at: NOW,
        },
      })),
    )
    expect(state.nextDue.complete).toBe(false)
    expect(state.nextDue.at).toBe(NOW + 120_000)
    expect(state.nextDue.sources[1]).toMatchObject({ state: 'unknown', reason: 'stale_cache' })
  })

  it('a source that does not answer in time is unknown, and does not hold the answer up', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const pending = build(source(() => new Promise<ScheduleReadResult>(() => undefined)))
    await vi.advanceTimersByTimeAsync(IDLE_SOURCE_READ_TIMEOUT_MS)
    const state = await pending
    expect(state.nextDue.sources[1]).toEqual({
      id: 'openclaw-gateway-cron',
      state: 'unknown',
      at: null,
      count: 0,
      timeZone: null,
      reason: 'timeout',
    })
    expect(state.nextDue.complete).toBe(false)
  })

  it('a Gateway on another machine is off: its cron runs whether or not this engine sleeps', async () => {
    const read = vi.fn(async () => ok([record(NOW + 60_000)]))
    const state = await build(source(read), true)
    expect(read).not.toHaveBeenCalled()
    expect(state.nextDue.sources[1]).toMatchObject({ state: 'off', reason: 'remote', at: null })
    expect(state.nextDue.at).toBeNull()
  })

  it('a source that throws, against its own contract, reads as unknown', async () => {
    const state = await build(source(() => Promise.reject(new Error('boom'))))
    expect(state.nextDue.sources[1]).toMatchObject({ state: 'unknown', reason: 'boom' })
  })
})
