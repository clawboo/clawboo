// The unified Scheduler REST surface with the REAL multiplexer + sources and
// the registry UNSTARTED (Gateway disconnected): the merged GET always 200s
// with the gateway source reporting degraded-as-data; routine writes land in
// the ledger; the typed error mapping covers 400 / 404 / 409 / 422 / 503.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, appendEvent, createTask, listScheduledRuns, setSetting, teams } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { resetScheduleMultiplexer } from '../../lib/scheduleSource/registry'
import {
  schedulesCreatePOST,
  schedulesDELETE,
  schedulesListGET,
  schedulesRunPOST,
  schedulesRunsGET,
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
    const db = getDb()
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'a1',
        name: 'A1',
        gatewayId: 'a1',
        // Not OpenClaw-sourced: a teamless OpenClaw agent is the Boo Zero fallback.
        sourceId: 'clawboo-native',
        runtime: 'clawboo-native',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(teams)
      .values({
        id: 't1',
        name: 'Research',
        icon: 'T',
        color: '#123456',
        leaderAgentId: 'lead',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values({
        id: 'lead',
        name: 'Lead',
        gatewayId: 'lead',
        runtime: 'claude-code',
        teamId: 't1',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
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
    const db = getDb()
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
    const db = getDb()
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
    expect(listScheduledRuns(getDb())[0]?.status).toBe('queued')
  })

  it('creates a TEAM routine by team, and lists it with the team and its lead named', async () => {
    const create = mockRes()
    await schedulesCreatePOST(
      req({
        body: {
          source: 'clawboo-routine',
          domain: 'team-task',
          target: 'team',
          teamId: 't1',
          cronSpec: '0 9 * * 1-5',
          label: 'Standup',
          taskTemplate: { description: 'Post the standup.' },
        },
      }),
      create.res,
    )
    expect(create.status()).toBe(201)
    expect((create.body() as { schedule: unknown }).schedule).toMatchObject({
      target: 'team',
      agentId: '',
      teamId: 't1',
    })

    const list = mockRes()
    await schedulesListGET(req(), list.res)
    const [row] = (list.body() as { schedules: Array<Record<string, unknown>> }).schedules
    // No Boo Zero in this install, so the team's own lead receives the fire.
    expect(row).toMatchObject({
      target: 'team',
      teamName: 'Research',
      agentName: 'Lead',
      runtime: 'claude-code',
      description: 'Post the standup.',
    })
  })

  it("a team routine's lead is Boo Zero once the install has one", async () => {
    const db = getDb()
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'bz',
        name: 'Boo Zero',
        gatewayId: 'bz',
        sourceId: 'clawboo-native',
        runtime: 'clawboo-native',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    setSetting(db, 'boo-zero:native-agent-id', 'bz')
    const create = mockRes()
    await schedulesCreatePOST(
      req({
        body: {
          source: 'clawboo-routine',
          domain: 'team-task',
          target: 'team',
          teamId: 't1',
          cronSpec: '0 9 * * *',
          label: 'Standup',
        },
      }),
      create.res,
    )
    const list = mockRes()
    await schedulesListGET(req(), list.res)
    const [row] = (list.body() as { schedules: Array<Record<string, unknown>> }).schedules
    expect(row).toMatchObject({ agentName: 'Boo Zero', runtime: 'clawboo-native' })
  })

  it('names the agent of an agent routine in the list', async () => {
    const create = mockRes()
    await schedulesCreatePOST(req({ body: { ...CREATE_BODY } }), create.res)
    const list = mockRes()
    await schedulesListGET(req(), list.res)
    const [row] = (list.body() as { schedules: Array<Record<string, unknown>> }).schedules
    expect(row).toMatchObject({ target: 'agent', agentId: 'a1', agentName: 'A1', teamId: null })
    expect(row).not.toHaveProperty('teamName')
  })

  it('a team routine needs a team, and a real one', async () => {
    const noTeam = mockRes()
    await schedulesCreatePOST(
      req({
        body: {
          source: 'clawboo-routine',
          domain: 'team-task',
          target: 'team',
          cronSpec: '0 9 * * *',
        },
      }),
      noTeam.res,
    )
    expect(noTeam.status()).toBe(400)
    expect((noTeam.body() as { code: string }).code).toBe('invalid_body')

    const unknownTeam = mockRes()
    await schedulesCreatePOST(
      req({
        body: {
          source: 'clawboo-routine',
          domain: 'team-task',
          target: 'team',
          teamId: 'nope',
          cronSpec: '0 9 * * *',
        },
      }),
      unknownTeam.res,
    )
    expect(unknownTeam.status()).toBe(400)
    expect((unknownTeam.body() as { code: string }).code).toBe('invalid_routine_target')

    const badTarget = mockRes()
    await schedulesCreatePOST(req({ body: { ...CREATE_BODY, target: 'everyone' } }), badTarget.res)
    expect(badTarget.status()).toBe(400)
    expect(listScheduledRuns(getDb())).toHaveLength(0)
  })

  it('an agent paired with a team it is not on is a 400', async () => {
    const r = mockRes()
    await schedulesCreatePOST(req({ body: { ...CREATE_BODY, teamId: 't1' } }), r.res)
    expect(r.status()).toBe(400)
    expect((r.body() as { code: string }).code).toBe('invalid_routine_target')
  })

  it('GET :id/runs returns recent fires with their board task, newest first', async () => {
    const create = mockRes()
    await schedulesCreatePOST(req({ body: { ...CREATE_BODY } }), create.res)
    const schedule = (create.body() as { schedule: { id: string; sourceScheduleId: string } })
      .schedule
    const db = getDb()
    const task = createTask(db, { title: 'Weekly report', status: 'done' })
    const runId = schedule.sourceScheduleId
    appendEvent(db, { kind: 'routine_fired', ts: 10, data: { scheduledRunId: runId } })
    appendEvent(db, {
      kind: 'routine_dispatched',
      ts: 11,
      taskId: task.id,
      data: { scheduledRunId: runId, taskId: task.id, dispatchPath: 'one-shot' },
    })
    appendEvent(db, {
      kind: 'routine_completed',
      ts: 12,
      taskId: task.id,
      data: { scheduledRunId: runId, taskId: task.id, status: 'idle' },
    })
    // A later fire the server never finished: the routine row has since gone
    // back to idle, so it can only have been cut off.
    appendEvent(db, { kind: 'routine_fired', ts: 20, data: { scheduledRunId: runId } })

    const r = mockRes()
    schedulesRunsGET(req({ params: { id: schedule.id } }), r.res)
    expect(r.status()).toBe(200)
    const { runs } = r.body() as { runs: Array<Record<string, unknown>> }
    expect(runs).toHaveLength(2)
    expect(runs[0]).toMatchObject({ firedAt: 20, status: 'interrupted', task: null })
    expect(runs[1]).toMatchObject({
      firedAt: 10,
      finishedAt: 12,
      status: 'succeeded',
      task: { id: task.id, title: 'Weekly report', status: 'done' },
    })
  })

  it('GET :id/runs is empty for a Gateway job and 404 for an unknown routine', () => {
    const gateway = mockRes()
    schedulesRunsGET(req({ params: { id: 'openclaw-gateway-cron:job-1' } }), gateway.res)
    expect(gateway.status()).toBe(200)
    expect(gateway.body()).toEqual({ runs: [] })

    const missing = mockRes()
    schedulesRunsGET(req({ params: { id: 'clawboo-routine:nope' } }), missing.res)
    expect(missing.status()).toBe(404)

    const garbage = mockRes()
    schedulesRunsGET(req({ params: { id: 'mystery:1' } }), garbage.res)
    expect(garbage.status()).toBe(404)
  })
})
