// The unified Scheduler REST surface with the REAL multiplexer + sources and
// the registry UNSTARTED (Gateway disconnected): the merged GET always 200s
// with the gateway source reporting degraded-as-data; routine writes land in
// the ledger; the typed error mapping covers 400 / 404 / 409 / 422 / 503.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  appendEvent,
  createTask,
  listScheduledRuns,
  setSetting,
  teams,
  liftPause,
  placePause,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../../lib/db'
import { resetScheduleMultiplexer } from '../../lib/scheduleSource/registry'
import {
  schedulesCreatePOST,
  schedulesDELETE,
  schedulesListGET,
  schedulesOccurrencesGET,
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
const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, headers: DASHBOARD, ...over }) as unknown as Request

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
    expect(getDbPath().startsWith(home)).toBe(true)
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

  describe('a routine that files Urgent tasks', () => {
    const urgent = { ...CREATE_BODY, taskTemplate: { title: 'Daily report', priority: 2 } }
    const storedPriority = (): number =>
      (JSON.parse(listScheduledRuns(getDb())[0]!.taskTemplate) as { priority: number }).priority

    it('refuses anything but a person on create, and files nothing', async () => {
      const other = mockRes()
      await schedulesCreatePOST(req({ body: urgent, headers: {} }), other.res)
      expect(other.status()).toBe(403)
      expect(listScheduledRuns(getDb())).toEqual([])
    })

    it('keeps Urgent from the dashboard on create', async () => {
      const person = mockRes()
      await schedulesCreatePOST(req({ body: urgent, headers: DASHBOARD }), person.res)
      expect(person.status()).toBe(201)
      expect(storedPriority()).toBe(2)
    })

    it('keeps Urgent from a person a sign-in proxy vouched for, in a script', async () => {
      const person = mockRes()
      await schedulesCreatePOST(
        req({ body: urgent, headers: {}, person: { id: 'user-42', name: 'Ada', role: null } }),
        person.res,
      )
      expect(person.status()).toBe(201)
      expect(storedPriority()).toBe(2)
    })

    it('holds a change to Urgent to the same rule', async () => {
      const made = mockRes()
      await schedulesCreatePOST(req({ body: CREATE_BODY, headers: DASHBOARD }), made.res)
      const before = storedPriority()
      const id = (made.body() as { schedule: { id: string } }).schedule.id
      const params = { id } as never
      const patch = { patch: { taskTemplate: { title: 'Daily report', priority: 2 } } }
      const refused = mockRes()
      await schedulesUpdatePATCH(req({ params, body: patch, headers: {} }), refused.res)
      expect(refused.status()).toBe(403)
      expect(storedPriority()).toBe(before)
      await schedulesUpdatePATCH(req({ params, body: patch, headers: DASHBOARD }), mockRes().res)
      expect(storedPriority()).toBe(2)
    })
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
    // Its own code, so a client can tell a bad spec from a missing field.
    expect((badSpec.body() as { code: string }).code).toBe('invalid_cron_spec')
    expect((bad.body() as { code: string }).code).toBe('invalid_body')

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

  it('refuses "Run now" while a pause covers the routine, in words a person reads', async () => {
    const create = mockRes()
    await schedulesCreatePOST(req({ body: { ...CREATE_BODY } }), create.res)
    const id = (create.body() as { schedule: { id: string } }).schedule.id
    const row = listScheduledRuns(getDb())[0]!
    placePause(getDb(), { kind: 'agent', id: row.agentId })

    const refused = mockRes()
    await schedulesRunPOST(req({ params: { id } }), refused.res)
    expect(refused.status()).toBe(409)
    expect((refused.body() as { error: string }).error).toContain('This agent is paused')
    expect(listScheduledRuns(getDb())[0]?.status).toBe('idle')

    liftPause(getDb(), 'agent', row.agentId)
    const run = mockRes()
    await schedulesRunPOST(req({ params: { id } }), run.res)
    expect(run.status()).toBe(202)
  })

  it('says on the list that a pause holds a routine, and draws it no upcoming runs', async () => {
    const create = mockRes()
    await schedulesCreatePOST(req({ body: { ...CREATE_BODY } }), create.res)
    const id = (create.body() as { schedule: { id: string } }).schedule.id
    const row = listScheduledRuns(getDb())[0]!
    const listed = async (): Promise<{ id: string; heldBy?: unknown }> => {
      const list = mockRes()
      await schedulesListGET(req({}), list.res)
      return (list.body() as { schedules: Array<{ id: string; heldBy?: unknown }> }).schedules.find(
        (s) => s.id === id,
      )!
    }
    const upcoming = async (): Promise<unknown[]> => {
      const res = mockRes()
      await schedulesOccurrencesGET(
        req({ query: { bounds: `${Date.now()},${Date.now() + 10 * 86_400_000}` } }),
        res.res,
      )
      return (res.body() as { routines: unknown[] }).routines
    }

    expect((await listed()).heldBy ?? null).toBeNull()
    expect((await upcoming()).length).toBeGreaterThan(0)

    placePause(getDb(), { kind: 'agent', id: row.agentId })
    expect((await listed()).heldBy).toMatchObject({ kind: 'agent', id: row.agentId, name: 'A1' })
    expect(await upcoming()).toEqual([])
  })

  it('refuses "Run now" on a team routine whose lead is paused, and shows it on hold', async () => {
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
    const id = (create.body() as { schedule: { id: string } }).schedule.id
    placePause(getDb(), { kind: 'agent', id: 'lead' })

    const refused = mockRes()
    await schedulesRunPOST(req({ params: { id } }), refused.res)
    expect(refused.status()).toBe(409)
    expect((refused.body() as { error: string }).error).toContain('This agent is paused')
    expect(listScheduledRuns(getDb())[0]?.status).toBe('idle')

    const list = mockRes()
    await schedulesListGET(req(), list.res)
    expect(
      (list.body() as { schedules: Array<{ heldBy?: unknown }> }).schedules[0]?.heldBy,
    ).toMatchObject({ kind: 'agent', id: 'lead', name: 'Lead' })
  })

  it('pause / resume / run round-trip through PATCH + POST :id/run', async () => {
    const create = mockRes()
    await schedulesCreatePOST(req({ body: { ...CREATE_BODY } }), create.res)
    const id = (create.body() as { schedule: { id: string } }).schedule.id

    const pause = mockRes()
    await schedulesUpdatePATCH(req({ params: { id }, body: { action: 'pause' } }), pause.res)
    expect(pause.status()).toBe(200)
    expect(pause.body()).toMatchObject({
      schedule: { status: 'paused', nextRunAt: null, agentName: 'A1' },
    })

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
    // The create answer names the team and its lead the same way the list does.
    expect((create.body() as { schedule: unknown }).schedule).toMatchObject({
      target: 'team',
      agentId: '',
      teamId: 't1',
      teamName: 'Research',
      agentName: 'Lead',
      runtime: 'claude-code',
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
