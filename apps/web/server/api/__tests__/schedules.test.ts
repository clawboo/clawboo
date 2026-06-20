// The unified Scheduler REST surface with the REAL multiplexer + sources and
// the registry UNSTARTED (Gateway disconnected): the merged GET always 200s
// with the gateway source reporting degraded-as-data; routine writes land in
// the ledger; the typed error mapping covers 400 / 404 / 409 / 422 / 503.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, createDb, createTask, listScheduledRuns } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../../lib/db'
import { resetScheduleMultiplexer } from '../../lib/scheduleSource/registry'
import {
  schedulesCreatePOST,
  schedulesDELETE,
  schedulesListGET,
  schedulesRunPOST,
  schedulesUpdatePATCH,
} from '../schedules'

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
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, ...over }) as unknown as Request

const CREATE_BODY = {
  source: 'clawboo-routine',
  domain: 'team-task',
  agentId: 'a1',
  cronSpec: '0 9 * * 1',
  label: 'Weekly report',
}

describe('schedules REST (gateway disconnected)', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-schedules-rest-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    resetScheduleMultiplexer()
    const db = createDb(getDbPath())
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'a1',
        name: 'A1',
        gatewayId: 'a1',
        runtime: 'clawboo-native',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    resetScheduleMultiplexer()
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('POST creates a routine (201), GET merges it with the degraded gateway status', async () => {
    const create = mockRes()
    await schedulesCreatePOST(req({ body: { ...CREATE_BODY } }), create.res)
    expect(create.status()).toBe(201)
    const created = (create.body() as { schedule: { id: string; domain: string; owner: string } })
      .schedule
    expect(created).toMatchObject({
      domain: 'team-task',
      owner: 'clawboo',
      manageability: 'managed',
    })

    const list = mockRes()
    await schedulesListGET(req(), list.res)
    expect(list.status()).toBe(200)
    const body = list.body() as {
      schedules: Array<{ id: string; source: string }>
      sources: Array<{ sourceId: string; ok: boolean; degraded: boolean; reason?: string }>
    }
    expect(body.schedules).toHaveLength(1)
    expect(body.schedules[0]?.id).toBe(created.id)
    const gw = body.sources.find((s) => s.sourceId === 'openclaw-gateway-cron')
    expect(gw).toMatchObject({ ok: false, degraded: true, reason: 'gateway_disconnected' })
    const routine = body.sources.find((s) => s.sourceId === 'clawboo-routine')
    expect(routine).toMatchObject({ ok: true, degraded: false })
  })

  it('a duplicate bound registration is a 409 (one firing-owner; never retried)', async () => {
    const db = createDb(getDbPath())
    const task = createTask(db, { title: 'Owned elsewhere', scheduledBy: 'openclaw' })
    const r = mockRes()
    // A bound routine must be one-shot (once@); the ownership conflict still applies.
    await schedulesCreatePOST(
      req({
        body: { ...CREATE_BODY, cronSpec: 'once@2099-01-01T00:00:00.000Z', teamTaskId: task.id },
      }),
      r.res,
    )
    expect(r.status()).toBe(409)
    expect((r.body() as { code: string }).code).toBe('duplicate_firing_owner')
  })

  it('a RECURRING schedule bound to a team task is a 400 (must be one-shot)', async () => {
    const db = createDb(getDbPath())
    const task = createTask(db, { title: 'Bound', status: 'todo' })
    const r = mockRes()
    await schedulesCreatePOST(req({ body: { ...CREATE_BODY, teamTaskId: task.id } }), r.res) // recurring + bound
    expect(r.status()).toBe(400)
    expect((r.body() as { code: string }).code).toBe('bound_recurring_schedule')
  })

  it('a team-task create aimed at the gateway source is a 422', async () => {
    const r = mockRes()
    await schedulesCreatePOST(
      req({ body: { ...CREATE_BODY, source: 'openclaw-gateway-cron' } }),
      r.res,
    )
    expect(r.status()).toBe(422)
    expect((r.body() as { code: string }).code).toBe('team_task_domain_violation')
  })

  it('a gateway-targeted write while disconnected is a 503 gateway_disconnected', async () => {
    const r = mockRes()
    await schedulesDELETE(req({ params: { id: 'openclaw-gateway-cron:job-1' } }), r.res)
    expect(r.status()).toBe(503)
    expect((r.body() as { error: string }).error).toBe('gateway_disconnected')
  })

  it('maps bad bodies to 400 and unknown ids to 404', async () => {
    const bad = mockRes()
    await schedulesCreatePOST(req({ body: { source: 'clawboo-routine' } }), bad.res)
    expect(bad.status()).toBe(400)

    const badSpec = mockRes()
    await schedulesCreatePOST(
      req({ body: { ...CREATE_BODY, cronSpec: 'not a spec' } }),
      badSpec.res,
    )
    expect(badSpec.status()).toBe(400)

    const missing = mockRes()
    await schedulesUpdatePATCH(
      req({ params: { id: 'clawboo-routine:nope' }, body: { action: 'pause' } }),
      missing.res,
    )
    expect(missing.status()).toBe(404)

    const unknownSource = mockRes()
    await schedulesDELETE(req({ params: { id: 'mystery:1' } }), unknownSource.res)
    expect(unknownSource.status()).toBe(404)
  })

  it('pause / resume / run round-trip through PATCH + POST :id/run', async () => {
    const create = mockRes()
    await schedulesCreatePOST(req({ body: { ...CREATE_BODY } }), create.res)
    const id = (create.body() as { schedule: { id: string } }).schedule.id

    const pause = mockRes()
    await schedulesUpdatePATCH(req({ params: { id }, body: { action: 'pause' } }), pause.res)
    expect(pause.status()).toBe(200)
    expect((pause.body() as { schedule: { status: string } }).schedule.status).toBe('paused')

    // A paused routine can't be force-fired — 409 illegal transition.
    const runPaused = mockRes()
    await schedulesRunPOST(req({ params: { id } }), runPaused.res)
    expect(runPaused.status()).toBe(409)

    const resume = mockRes()
    await schedulesUpdatePATCH(req({ params: { id }, body: { action: 'resume' } }), resume.res)
    expect((resume.body() as { schedule: { status: string } }).schedule.status).toBe('idle')

    const run = mockRes()
    await schedulesRunPOST(req({ params: { id } }), run.res)
    expect(run.status()).toBe(202)
    expect(listScheduledRuns(createDb(getDbPath()))[0]?.status).toBe('queued')
  })
})
