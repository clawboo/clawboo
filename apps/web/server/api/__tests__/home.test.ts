// Home's routes against a real database in a sandboxed HOME: the person check on
// every write, another team's records answering 404, the one-call Home read for a
// team and for All teams (a guest cut to their teams), goal links on the board's
// create and patch, the weekly-update routine, and the status-line asks.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import * as client from '@clawboo/control-client'
import * as homeDb from '@clawboo/db'
import {
  agents,
  archiveTeamGoal,
  createSubtask,
  createTask,
  createTeamGoal,
  createTeamKpi,
  getSetting,
  getTask,
  getTeamGoal,
  getTeamHomeSettings,
  goalDetail,
  listScheduledRuns,
  setTeamHomeSettings,
  tasks,
  teamHomeSettingKey,
  teams,
  updateTeamGoal,
} from '@clawboo/db'
import { DEFAULT_AGENT_CONFIG } from '@clawboo/adapter-native'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/teamChat/boardDispatch', () => ({
  requestTaskDispatch: () => undefined,
  pumpRoomOfTask: () => undefined,
}))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const home = await import('../home')
const { boardCreatePOST, boardGetGET, boardListGET, boardUpdatePATCH } = await import('../board')
const { askLeadsForStatus, STATUS_ASK_ROUTINE_NAME } = await import('../../lib/home/statusAsks')
const { saveAgentConfig } = await import('../../lib/runtimes/native/agentConfigStore')

interface Body {
  ok?: boolean
  error?: string
  [key: string]: unknown
}

function mockRes(): { res: Response; status: () => number; body: () => Body } {
  let code = 200
  let payload: unknown
  const res = {
    headersSent: false,
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, status: () => code, body: () => payload as Body }
}

const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const req = (over: Partial<Request> & { roleScope?: unknown } = {}): Request =>
  ({
    params: {},
    query: {},
    body: {},
    headers: {},
    app: { locals: {} },
    socket: { localPort: 3000 },
    ...over,
  }) as unknown as Request
const asPerson = (over: Partial<Request> = {}): Request => req({ headers: DASHBOARD, ...over })

type Handler = (r: Request, s: Response) => Promise<void>
async function call(fn: Handler, r: Request): Promise<{ status: number; body: Body }> {
  const m = mockRes()
  await fn(r, m.res)
  return { status: m.status(), body: m.body() }
}

const PERSON = { kind: 'person' as const, id: 'local', name: 'You' }

describe('Home routes', () => {
  let dir: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-home-routes-'))
    await mkdir(path.join(dir, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = dir
    process.env['CLAWBOO_HOME'] = path.join(dir, '.clawboo')
    expect(getDbPath().startsWith(dir)).toBe(true)
    const db = getDb()
    const now = Date.now()
    for (const id of ['T', 'U'])
      db.insert(teams)
        .values({ id, name: `Team ${id}`, icon: 'i', color: 'c', createdAt: now, updatedAt: now })
        .run()
    db.insert(agents)
      .values({
        id: 'a1',
        runtime: 'hermes',
        name: 'Ada',
        teamId: 'T',
        gatewayId: 'gw',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    createTask(db, { title: 'Other work', teamId: 'U' })
  })

  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(dir, { recursive: true, force: true })
  })

  function goalOn(teamId: string, title = 'Launch'): string {
    const r = createTeamGoal(getDb(), teamId, { title }, PERSON)
    if (!r.ok) throw new Error(r.reason)
    return r.value.id
  }

  it('refuses a write that may not act as the person', async () => {
    const out = await call(
      home.homeGoalsPOST,
      req({ params: { teamId: 'T' }, body: { title: 'X' } }),
    )
    expect(out).toEqual({ status: 403, body: { ok: false, error: 'person_only' } })
    const ok = await call(
      home.homeGoalsPOST,
      asPerson({ params: { teamId: 'T' }, body: { title: 'Ship' } }),
    )
    expect(ok.status).toBe(200)
    expect((ok.body['goal'] as { createdBy: unknown }).createdBy).toMatchObject({ kind: 'person' })
  })

  it("answers 404 for another team's goal, KPI or page, and for no such team", async () => {
    const g = goalOn('U')
    expect((await call(home.homeGoalGET, req({ params: { teamId: 'T', goalId: g } }))).status).toBe(
      404,
    )
    expect(
      (
        await call(
          home.homeGoalPATCH,
          asPerson({ params: { teamId: 'T', goalId: g }, body: { title: 'Mine now' } }),
        )
      ).status,
    ).toBe(404)
    expect((await call(home.homeGoalsGET, req({ params: { teamId: 'nope' } }))).body).toEqual({
      ok: false,
      error: 'team_not_found',
    })
  })

  it('reads one team, or All teams cut to a guest', async () => {
    goalOn('T')
    const team = await call(home.homeGET, req({ query: { teamId: 'T' } }))
    expect(team.body['scope']).toBe('team')
    const teamHome = team.body['home'] as {
      goals: unknown[]
      recentFiles: unknown[]
      status: { source: string }
    }
    expect(teamHome.goals).toHaveLength(1)
    expect(teamHome.recentFiles).toEqual([])
    expect(teamHome.status.source).toBe('computed')
    const all = await call(home.homeGET, req())
    expect(all.body['scope']).toBe('all')
    expect((all.body['home'] as { teams: unknown[] }).teams).toHaveLength(2)
    const guest = { teams: new Set(['U']) }
    const cut = await call(home.homeGET, req({ roleScope: guest }))
    expect(
      (cut.body['home'] as { teams: Array<{ team: { id: string } }> }).teams.map((t) => t.team.id),
    ).toEqual(['U'])
    expect(
      (await call(home.homeGET, req({ query: { teamId: 'T' }, roleScope: guest }))).status,
    ).toBe(404)
  })

  it('takes a person value only on a person-source KPI', async () => {
    const db = getDb()
    const agentKpi = createTeamKpi(db, 'T', { name: 'Signups', source: 'agent' }, PERSON)
    if (!agentKpi.ok) throw new Error(agentKpi.reason)
    const refused = await call(
      home.homeKpiValuesPOST,
      asPerson({ params: { teamId: 'T', kpiId: agentKpi.value.id }, body: { value: 4 } }),
    )
    expect(refused).toEqual({ status: 400, body: { ok: false, error: 'wrong_source' } })
    const created = await call(
      home.homeKpisPOST,
      asPerson({
        params: { teamId: 'T' },
        body: { name: 'NPS', source: 'person', staleAfterHours: 48 },
      }),
    )
    const kpiId = (created.body['kpi'] as { kpi: { id: string } }).kpi.id
    const value = await call(
      home.homeKpiValuesPOST,
      asPerson({ params: { teamId: 'T', kpiId }, body: { value: 42 } }),
    )
    expect(value.status).toBe(200)
    expect(
      (value.body['kpi'] as { reading: { value: number; freshness: string } }).reading,
    ).toMatchObject({
      value: 42,
      freshness: 'ok',
    })
  })

  it('a page edit is a new revision and a revert copies an old one', async () => {
    const made = await call(
      home.homePagesPOST,
      asPerson({ params: { teamId: 'T' }, body: { title: 'Plan', body: 'one' } }),
    )
    const pageId = (made.body['page'] as { id: string }).id
    await call(
      home.homePagePATCH,
      asPerson({ params: { teamId: 'T', pageId }, body: { body: 'two' } }),
    )
    const reverted = await call(
      home.homePageRevertPOST,
      asPerson({ params: { teamId: 'T', pageId }, body: { revision: 1 } }),
    )
    expect(reverted.body['page']).toMatchObject({ revision: 3, body: 'one' })
    const revs = await call(home.homePageRevisionsGET, req({ params: { teamId: 'T', pageId } }))
    expect((revs.body['revisions'] as unknown[]).length).toBe(3)
  })

  it('links a board task to a goal of its own team, as a person only', async () => {
    const db = getDb()
    const mine = goalOn('T')
    const theirs = goalOn('U', 'Theirs')
    const created = await call(
      boardCreatePOST as Handler,
      asPerson({ body: { title: 'Linked', teamId: 'T', goalId: mine } }),
    )
    const taskId = (created.body['task'] as { id: string; goalId: string }).id
    expect(getTask(db, taskId)?.goalId).toBe(mine)
    // A caller that is not a person cannot name a goal: its task takes its parent's.
    const scripted = await call(
      boardCreatePOST as Handler,
      req({ body: { title: 'Scripted', teamId: 'T', goalId: mine } }),
    )
    expect(getTask(db, (scripted.body['task'] as { id: string }).id)?.goalId).toBeNull()
    expect(
      (
        await call(
          boardCreatePOST as Handler,
          asPerson({ body: { title: 'X', teamId: 'T', goalId: theirs } }),
        )
      ).body,
    ).toEqual({ error: 'goal_other_team' })
    const notPerson = await call(
      boardUpdatePATCH as Handler,
      req({ params: { taskId }, body: { goalId: null } }),
    )
    expect(notPerson.status).toBe(403)
    const wrongTeam = await call(
      boardUpdatePATCH as Handler,
      asPerson({ params: { taskId }, body: { goalId: theirs } }),
    )
    expect(wrongTeam).toEqual({ status: 400, body: { error: 'goal_other_team' } })
    await call(
      boardUpdatePATCH as Handler,
      asPerson({ params: { taskId }, body: { goalId: null } }),
    )
    expect(getTask(db, taskId)?.goalId).toBeNull()
  })

  it('turns on weekly updates once, as a team routine', async () => {
    const first = await call(home.homeWeeklyUpdatesPOST, asPerson({ params: { teamId: 'T' } }))
    expect(first.status).toBe(200)
    expect(first.body['created']).toBe(true)
    const again = await call(home.homeWeeklyUpdatesPOST, asPerson({ params: { teamId: 'T' } }))
    expect(again.body).toMatchObject({ created: false, routineId: first.body['routineId'] })
    const runs = listScheduledRuns(getDb()).filter((r) => r.teamId === 'T')
    expect(runs).toHaveLength(1)
    expect(JSON.parse(runs[0]!.taskTemplate)).toMatchObject({
      target: 'team',
      title: 'Weekly goal updates',
    })
    expect(getTeamHomeSettings(getDb(), 'T').weeklyUpdatesRoutineId).toBe(first.body['routineId'])
  })

  it('asks a lead for a status line only when on, once the board moved, once per window', async () => {
    const asked: Array<{ teamId: string; name: string | undefined }> = []
    const enqueue = async (teamId: string, input: { routine?: { name: string } }) => {
      asked.push({ teamId, name: input.routine?.name })
      return { ok: true as const, targetAgentId: 'a1' }
    }
    const db = getDb()
    const later = Date.now() + 10_000
    createTask(db, { title: 'Moved the board', teamId: 'T' })
    expect(await askLeadsForStatus({ enqueue, now: later })).toEqual([])
    setTeamHomeSettings(db, 'T', { leadWritesStatus: true })
    // Nothing moved since it was turned on: no ask.
    expect(await askLeadsForStatus({ enqueue, now: later })).toEqual([])
    const t = createTask(db, { title: 'More work', teamId: 'T' })
    db.update(tasks)
      .set({ updatedAt: later - 1 })
      .where(eq(tasks.id, t.id))
      .run()
    expect(await askLeadsForStatus({ enqueue, now: later })).toEqual(['T'])
    expect(await askLeadsForStatus({ enqueue, now: later + 1000 })).toEqual([])
    expect(asked).toEqual([{ teamId: 'T', name: STATUS_ASK_ROUTINE_NAME }])
  })

  it('asks a quiet board again after an ask that failed to post', async () => {
    const db = getDb()
    const later = Date.now() + 10_000
    setTeamHomeSettings(db, 'T', { leadWritesStatus: true })
    const t = createTask(db, { title: 'More work', teamId: 'T' })
    db.update(tasks)
      .set({ updatedAt: later - 1 })
      .where(eq(tasks.id, t.id))
      .run()
    const failed = async () => ({ ok: false as const, error: 'paused', paused: true as const })
    expect(await askLeadsForStatus({ enqueue: failed, now: later })).toEqual([])
    const threw = async (): Promise<never> => {
      throw new Error('engine down')
    }
    expect(await askLeadsForStatus({ enqueue: threw, now: later + 1000 })).toEqual([])
    // The board has not moved since, and it is minutes later, not hours.
    const posted = async () => ({ ok: true as const, targetAgentId: 'a1' })
    expect(await askLeadsForStatus({ enqueue: posted, now: later + 2000 })).toEqual(['T'])
    expect(await askLeadsForStatus({ enqueue: posted, now: later + 3000 })).toEqual([])
  })

  it('never turns on, or asks, a lead that cannot write the line', async () => {
    const db = getDb()
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'oc',
        runtime: 'openclaw',
        name: 'Oc',
        teamId: 'U',
        gatewayId: 'oc',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const refused = await call(
      home.homeSettingsPUT,
      asPerson({ params: { teamId: 'U' }, body: { leadWritesStatus: true } }),
    )
    expect(refused).toEqual({ status: 409, body: { ok: false, error: 'lead_cannot_write' } })
    const read = await call(home.homeSettingsGET, req({ params: { teamId: 'U' } }))
    expect(read.body['settings']).toMatchObject({
      leadWritesStatus: false,
      leadCanWriteStatus: false,
      leadCannotWriteReason: 'openclaw_lead',
    })
    const ok = await call(
      home.homeSettingsPUT,
      asPerson({ params: { teamId: 'T' }, body: { leadWritesStatus: true } }),
    )
    expect(ok.body['settings']).toMatchObject({ leadWritesStatus: true, leadCanWriteStatus: true })
    // Turned on while a lead could write, then the lead became an OpenClaw agent: skipped.
    setTeamHomeSettings(db, 'U', { leadWritesStatus: true })
    const t = createTask(db, { title: 'Work', teamId: 'U' })
    db.update(tasks)
      .set({ updatedAt: now + 5000 })
      .where(eq(tasks.id, t.id))
      .run()
    const asked: string[] = []
    await askLeadsForStatus({
      now: now + 10_000,
      enqueue: async (teamId) => {
        asked.push(teamId)
        return { ok: true as const, targetAgentId: 'oc' }
      },
    })
    expect(asked).not.toContain('U')
  })

  it('refuses the line for a native lead whose board access is read-only or off, and says why', async () => {
    const db = getDb()
    const now = Date.now()
    const reasonOf = async (): Promise<unknown> =>
      (await call(home.homeSettingsGET, req({ params: { teamId: 'U' } }))).body['settings']
    const turnOn = () =>
      call(
        home.homeSettingsPUT,
        asPerson({ params: { teamId: 'U' }, body: { leadWritesStatus: true } }),
      )
    expect(await reasonOf()).toMatchObject({
      leadCanWriteStatus: false,
      leadCannotWriteReason: 'no_lead',
    })
    db.insert(agents)
      .values({
        id: 'nat',
        runtime: 'clawboo-native',
        name: 'Nat',
        teamId: 'U',
        gatewayId: 'nat',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const access = (tasks: boolean | 'read') =>
      saveAgentConfig(db, {
        ...DEFAULT_AGENT_CONFIG,
        id: 'nat',
        tools: { ...DEFAULT_AGENT_CONFIG.tools, tasks },
      })
    // No stored config: the native default, read-only board access.
    expect(await reasonOf()).toMatchObject({
      leadCanWriteStatus: false,
      leadCannotWriteReason: 'tasks_read_only',
    })
    expect((await turnOn()).status).toBe(409)
    access(false)
    expect(await reasonOf()).toMatchObject({ leadCannotWriteReason: 'tasks_off' })
    expect((await turnOn()).status).toBe(409)
    // Turned on earlier, then the lead's access became read-only: never asked.
    setTeamHomeSettings(db, 'U', { leadWritesStatus: true })
    access('read')
    const t = createTask(db, { title: 'Work', teamId: 'U' })
    db.update(tasks)
      .set({ updatedAt: now + 5000 })
      .where(eq(tasks.id, t.id))
      .run()
    const asked: string[] = []
    await askLeadsForStatus({
      now: now + 10_000,
      enqueue: async (teamId) => {
        asked.push(teamId)
        return { ok: true as const, targetAgentId: 'nat' }
      },
    })
    expect(asked).not.toContain('U')
    // Full board access: the lead holds write_home_summary.
    setTeamHomeSettings(db, 'U', { leadWritesStatus: false })
    access(true)
    const on = await turnOn()
    expect(on.status).toBe(200)
    expect(on.body['settings']).toMatchObject({
      leadWritesStatus: true,
      leadCanWriteStatus: true,
      leadCannotWriteReason: null,
    })
  })

  it("unlinks a task under a goal-linked request, so it leaves the goal's count", async () => {
    const db = getDb()
    const g = goalOn('T')
    const main = createTask(db, { title: 'Request', teamId: 'T', goalId: g })
    db.update(tasks).set({ isMainTask: 1 }).where(eq(tasks.id, main.id)).run()
    const child = createSubtask(db, main.id, { title: 'Side quest' })
    const linked = () =>
      (goalDetail(db, 'T', g)?.tasks ?? []).map((t) => t.taskId).includes(child.id)
    expect(linked()).toBe(true)
    const out = await call(
      boardUpdatePATCH as Handler,
      asPerson({ params: { taskId: child.id }, body: { goalId: null } }),
    )
    expect(out.status).toBe(200)
    expect(linked()).toBe(false)
  })

  it('pages revisions, serves one by number, and refuses fractions and junk', async () => {
    const made = await call(
      home.homePagesPOST,
      asPerson({ params: { teamId: 'T' }, body: { title: 'Log', body: 'a' } }),
    )
    const pageId = (made.body['page'] as { id: string }).id
    for (const body of ['b', 'c'])
      await call(home.homePagePATCH, asPerson({ params: { teamId: 'T', pageId }, body: { body } }))
    const page1 = await call(
      home.homePageRevisionsGET,
      req({ params: { teamId: 'T', pageId }, query: { limit: '2' } }),
    )
    expect(page1.body).toMatchObject({ nextBefore: 2 })
    expect(
      (page1.body['revisions'] as Array<{ revision: number; body?: string }>).map((r) => [
        r.revision,
        r.body,
      ]),
    ).toEqual([
      [3, undefined],
      [2, undefined],
    ])
    const one = await call(
      home.homePageRevisionGET,
      req({ params: { teamId: 'T', pageId, revision: '1' } }),
    )
    expect(one.body['revision']).toMatchObject({ revision: 1, body: 'a' })
    expect(
      (
        await call(
          home.homePageRevisionGET,
          req({ params: { teamId: 'T', pageId, revision: '9' } }),
        )
      ).status,
    ).toBe(404)
    for (const query of [{ limit: '2.5' }, { limit: '0' }, { before: 'x' }])
      expect(
        (await call(home.homePageRevisionsGET, req({ params: { teamId: 'T', pageId }, query })))
          .status,
      ).toBe(400)
    const k = createTeamKpi(getDb(), 'T', { name: 'NPS', source: 'person' }, PERSON)
    if (!k.ok) throw new Error(k.reason)
    const frac = await call(
      home.homeKpiValuesGET,
      req({ params: { teamId: 'T', kpiId: k.value.id }, query: { limit: '2.5' } }),
    )
    expect(frac).toEqual({ status: 400, body: { ok: false, error: 'invalid' } })
  })

  it('deleting a team removes its Home settings and its goals', async () => {
    const { teamsDELETE } = await import('../teams')
    const db = getDb()
    const g = goalOn('U')
    setTeamHomeSettings(db, 'U', { leadWritesStatus: true })
    expect(getSetting(db, teamHomeSettingKey('U'))).not.toBeNull()
    const out = await call(teamsDELETE as unknown as Handler, asPerson({ params: { id: 'U' } }))
    expect(out.status).toBeLessThan(300)
    expect(getSetting(db, teamHomeSettingKey('U'))).toBeNull()
    expect(getTeamGoal(db, 'U', g)).toBeNull()
  })

  it('names the goal each board task counts toward, on the list and the detail', async () => {
    const db = getDb()
    const g = goalOn('T')
    const main = createTask(db, { title: 'Request', teamId: 'T', goalId: g })
    db.update(tasks).set({ isMainTask: 1 }).where(eq(tasks.id, main.id)).run()
    // Work filed before the request had its goal: nothing stored, still counts.
    const legacy = createTask(db, { title: 'Earlier hand-off', teamId: 'T', parentTaskId: main.id })
    db.update(tasks).set({ goalId: null }).where(eq(tasks.id, legacy.id)).run()
    const off = createSubtask(db, main.id, { title: 'Off the goal', goalId: null })
    const list = await call(boardListGET as Handler, req({ query: { teamId: 'T' } }))
    const rows = list.body['tasks'] as Array<Record<string, unknown>>
    const row = (id: string) => rows.find((r) => r['id'] === id)
    expect(row(main.id)).toMatchObject({ goalId: g, effectiveGoalId: g, goalLinkedVia: 'own' })
    expect(row(legacy.id)).toMatchObject({
      goalId: null,
      effectiveGoalId: g,
      goalLinkedVia: 'request',
    })
    expect(row(off.id)).toMatchObject({ effectiveGoalId: null, goalLinkedVia: null })
    const detail = await call(boardGetGET as Handler, req({ params: { taskId: legacy.id } }))
    expect(detail.body['task']).toMatchObject({ effectiveGoalId: g, goalLinkedVia: 'request' })
    const patched = await call(
      boardUpdatePATCH as Handler,
      asPerson({ params: { taskId: legacy.id }, body: { goalId: null } }),
    )
    expect(patched.body['task']).toMatchObject({ effectiveGoalId: null, goalLinkedVia: null })
  })

  it("lists a team's done and dropped goals with its active ones; archived only when asked", async () => {
    const db = getDb()
    const active = goalOn('T', 'Active')
    const done = goalOn('T', 'Done')
    const dropped = goalOn('T', 'Dropped')
    const archived = goalOn('T', 'Archived')
    updateTeamGoal(db, 'T', done, { status: 'done' })
    updateTeamGoal(db, 'T', dropped, { status: 'dropped' })
    archiveTeamGoal(db, 'T', archived)
    const ids = (out: { body: Body }) =>
      (out.body['goals'] as Array<{ goal: { id: string } }>).map((s) => s.goal.id).sort()
    const listed = await call(home.homeGoalsGET, req({ params: { teamId: 'T' } }))
    expect(ids(listed)).toEqual([active, done, dropped].sort())
    const all = await call(
      home.homeGoalsGET,
      req({ params: { teamId: 'T' }, query: { includeArchived: 'true' } }),
    )
    expect(ids(all)).toEqual([active, archived, done, dropped].sort())
    // Home itself shows the active ones.
    const team = await call(home.homeGET, req({ query: { teamId: 'T' } }))
    expect(
      (team.body['home'] as { goals: Array<{ goal: { id: string } }> }).goals.map((s) => s.goal.id),
    ).toEqual([active])
  })

  it('maps refusals to statuses', () => {
    expect(home.refusalStatus('goal_not_found')).toBe(404)
    expect(home.refusalStatus('not_draft')).toBe(409)
    expect(home.refusalStatus('too_many')).toBe(409)
    expect(home.refusalStatus('invalid_parent')).toBe(400)
  })

  it("keeps the control client's lists equal to the server's", () => {
    expect([...client.HOME_COMPUTED_METRICS]).toEqual([...homeDb.HOME_COMPUTED_METRICS])
    expect([...client.HOME_POINT_IN_TIME_METRICS]).toEqual([...homeDb.HOME_POINT_IN_TIME_METRICS])
    expect([...client.GOAL_STATUSES]).toEqual([...homeDb.GOAL_STATUSES])
    expect([...client.GOAL_HEALTHS]).toEqual([...homeDb.GOAL_HEALTHS])
    expect([...client.GOAL_UPDATE_STATES]).toEqual([...homeDb.GOAL_UPDATE_STATES])
    expect([...client.KPI_DIRECTIONS]).toEqual([...homeDb.KPI_DIRECTIONS])
    expect([...client.KPI_PERIODS]).toEqual([...homeDb.KPI_PERIODS])
    expect([...client.KPI_SOURCES]).toEqual([...homeDb.KPI_SOURCES])
    expect([...client.KPI_STATUSES]).toEqual([...homeDb.KPI_STATUSES])
  })
})

describe("a board change frame names the task's goal", () => {
  let dir: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-home-frame-'))
    await mkdir(path.join(dir, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = dir
    process.env['CLAWBOO_HOME'] = path.join(dir, '.clawboo')
    expect(getDbPath().startsWith(dir)).toBe(true)
    const now = Date.now()
    getDb()
      .insert(teams)
      .values({ id: 'T', name: 'Team T', icon: 'i', color: 'c', createdAt: now, updatedAt: now })
      .run()
  })

  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(dir, { recursive: true, force: true })
  })

  it('carries goalId, so a card can show its goal without a reload', async () => {
    const { publishBoardChangeWithAttention } =
      await import('../../lib/teamChat/publishBoardChange')
    const { subscribeBoardChange } = await import('../../lib/teamChat/boardChangeBus')
    const db = getDb()
    const g = createTeamGoal(db, 'T', { title: 'Launch' }, PERSON)
    if (!g.ok) throw new Error(g.reason)
    const t = createTask(db, { title: 'Linked', teamId: 'T', goalId: g.value.id })
    const frames: Array<Record<string, unknown>> = []
    const stop = subscribeBoardChange('T', (c) =>
      frames.push(c as unknown as Record<string, unknown>),
    )
    const main = createTask(db, { title: 'Request', teamId: 'T', goalId: g.value.id })
    db.update(tasks).set({ isMainTask: 1 }).where(eq(tasks.id, main.id)).run()
    const child = createSubtask(db, main.id, { title: 'Hand-off', goalId: null })
    db.update(tasks).set({ goalId: null, goalCleared: 0 }).where(eq(tasks.id, child.id)).run()
    publishBoardChangeWithAttention(db, 'T', { id: t.id, title: t.title })
    publishBoardChangeWithAttention(db, 'T', { id: child.id, title: child.title })
    stop()
    expect(frames[0]).toMatchObject({
      goalId: g.value.id,
      effectiveGoalId: g.value.id,
      goalLinkedVia: 'own',
    })
    // Stored nothing, counts toward its request's goal.
    expect(frames[1]).toMatchObject({
      goalId: null,
      effectiveGoalId: g.value.id,
      goalLinkedVia: 'request',
    })
  })
})
