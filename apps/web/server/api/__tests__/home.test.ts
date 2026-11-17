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
  createTask,
  createTeamGoal,
  createTeamKpi,
  getTask,
  getTeamHomeSettings,
  listScheduledRuns,
  setTeamHomeSettings,
  teams,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/teamChat/boardDispatch', () => ({
  requestTaskDispatch: () => undefined,
  pumpRoomOfTask: () => undefined,
}))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const home = await import('../home')
const { boardCreatePOST, boardUpdatePATCH } = await import('../board')
const { askLeadsForStatus, STATUS_ASK_ROUTINE_NAME } = await import('../../lib/home/statusAsks')

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

  it('asks a lead for a status line only when the team turned it on, once per window', async () => {
    const asked: Array<{ teamId: string; name: string | undefined }> = []
    const enqueue = async (teamId: string, input: { routine?: { name: string } }) => {
      asked.push({ teamId, name: input.routine?.name })
      return { ok: true as const, targetAgentId: 'a1' }
    }
    createTask(getDb(), { title: 'Moved the board', teamId: 'T' })
    expect(await askLeadsForStatus({ enqueue })).toEqual([])
    setTeamHomeSettings(getDb(), 'T', { leadWritesStatus: true })
    expect(await askLeadsForStatus({ enqueue })).toEqual(['T'])
    expect(await askLeadsForStatus({ enqueue })).toEqual([])
    expect(asked).toEqual([{ teamId: 'T', name: STATUS_ASK_ROUTINE_NAME }])
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
