// The scheduler time zone: GET/PUT /api/schedules/time-zone against a sandboxed
// ledger and the REAL routine source. With nothing stored the host's zone
// applies; a stored zone is validated, and storing one moves every armed
// routine's next run onto that zone's wall clock.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, getScheduledRun, scheduledRuns } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { resetScheduleMultiplexer } from '../../lib/scheduleSource/registry'
import { schedulesCreatePOST, schedulesTimeZoneGET, schedulesTimeZonePUT } from '../schedules'

function mockRes(): { res: Response; status: () => number; body: () => unknown } {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, status: () => code, body: () => payload }
}
const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, headers: DASHBOARD, ...over }) as unknown as Request

interface ZoneBody {
  timeZone: string
  hostTimeZone: string
  configured: boolean
}

const HOST = Intl.DateTimeFormat().resolvedOptions().timeZone
// UTC+14, which no process zone matches unless it is that zone itself.
const OTHER = HOST === 'Pacific/Kiritimati' ? 'Pacific/Pago_Pago' : 'Pacific/Kiritimati'

function clockIn(timeZone: string, ms: number): string {
  return new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  }).format(ms)
}

function getZone(): ZoneBody {
  const r = mockRes()
  schedulesTimeZoneGET(req(), r.res)
  expect(r.status()).toBe(200)
  return r.body() as ZoneBody
}

function putZone(timeZone: unknown): { status: number; body: unknown } {
  const r = mockRes()
  schedulesTimeZonePUT(req({ body: { timeZone } }), r.res)
  return { status: r.status(), body: r.body() }
}

async function createDaily(): Promise<string> {
  const r = mockRes()
  await schedulesCreatePOST(
    req({
      body: {
        source: 'clawboo-routine',
        domain: 'team-task',
        agentId: 'solo',
        cronSpec: '0 9 * * *',
      },
    }),
    r.res,
  )
  expect(r.status()).toBe(201)
  return (r.body() as { schedule: { id: string } }).schedule.id.split(':')[1]!
}

describe('the scheduler time zone', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-scheduler-tz-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    resetScheduleMultiplexer()
    const now = Date.now()
    getDb()
      .insert(agents)
      .values({
        id: 'solo',
        name: 'Solo',
        teamId: null,
        gatewayId: 'solo',
        sourceId: 'clawboo-native',
        runtime: 'clawboo-native',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    resetScheduleMultiplexer()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('is the host zone until one is stored', () => {
    expect(getZone()).toEqual({ timeZone: HOST, hostTimeZone: HOST, configured: false })
  })

  it('stores a zone, in its canonical spelling, and null follows the host again', () => {
    const put = putZone('utc')
    expect(put.status).toBe(200)
    expect(put.body).toEqual({ timeZone: 'UTC', hostTimeZone: HOST, configured: true })
    expect(getZone().timeZone).toBe('UTC')

    expect(putZone(null).body).toEqual({ timeZone: HOST, hostTimeZone: HOST, configured: false })
    expect(getZone().configured).toBe(false)
  })

  it('keeps the zone name a person picked rather than an older alias of it', () => {
    // Node reports this zone as Asia/Calcutta; the stored name stays as picked.
    expect((putZone('Asia/Kolkata').body as ZoneBody).timeZone).toBe('Asia/Kolkata')
    expect(getZone().timeZone).toBe('Asia/Kolkata')
  })

  it('refuses a name that is not a time zone, and a body without one', () => {
    for (const bad of ['Not/AZone', '', 'x'.repeat(100)]) {
      const put = putZone(bad)
      expect(put.status, bad).toBe(400)
      expect((put.body as { code: string }).code).toBe('invalid_time_zone')
    }
    for (const bad of [undefined, 42, { name: 'UTC' }]) {
      expect(putZone(bad).status).toBe(400)
    }
    expect(getZone().configured).toBe(false)
  })

  it('a routine created after the change is armed on the new zone’s wall clock', async () => {
    putZone(OTHER)
    const id = await createDaily()
    expect(clockIn(OTHER, getScheduledRun(getDb(), id)!.nextRunAt!)).toBe('09:00')
  })

  it('moves an armed routine’s next run when the zone changes, and leaves a paused one disarmed', async () => {
    const armed = await createDaily()
    const paused = await createDaily()
    getDb()
      .update(scheduledRuns)
      .set({ status: 'paused', nextRunAt: null })
      .where(eq(scheduledRuns.id, paused))
      .run()
    expect(clockIn(HOST, getScheduledRun(getDb(), armed)!.nextRunAt!)).toBe('09:00')

    putZone(OTHER)
    const moved = getScheduledRun(getDb(), armed)!
    expect(clockIn(OTHER, moved.nextRunAt!)).toBe('09:00')
    expect(moved.nextRunAt!).toBeGreaterThan(Date.now())
    expect(getScheduledRun(getDb(), paused)).toMatchObject({ status: 'paused', nextRunAt: null })

    putZone(null)
    expect(clockIn(HOST, getScheduledRun(getDb(), armed)!.nextRunAt!)).toBe('09:00')
  })

  it('keeps the old zone when moving the runs fails, so a retry does the whole change', async () => {
    const armed = await createDaily()
    const before = getScheduledRun(getDb(), armed)!.nextRunAt
    getDb().$client.exec(
      `CREATE TRIGGER refuse_rearm BEFORE UPDATE OF next_run_at ON scheduled_runs
       BEGIN SELECT RAISE(ABORT, 'refused'); END`,
    )
    expect(putZone(OTHER).status).toBe(500)
    expect(getZone()).toEqual({ timeZone: HOST, hostTimeZone: HOST, configured: false })
    expect(getScheduledRun(getDb(), armed)!.nextRunAt).toBe(before)

    getDb().$client.exec('DROP TRIGGER refuse_rearm')
    expect(putZone(OTHER).status).toBe(200)
    expect(clockIn(OTHER, getScheduledRun(getDb(), armed)!.nextRunAt!)).toBe('09:00')
  })
})
