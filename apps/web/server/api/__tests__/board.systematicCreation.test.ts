// The board's REST surface for readable ids, repeat-safe creates, the Urgent rule
// and labels. The dispatch is replaced by a recorder, as in board.assign.test.ts.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  createCappedSubtask,
  createTask,
  getTask,
  linkDep,
  listEvents,
  noteDelegationFailure,
  readDelegationFailure,
  tasks,
  teams,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dispatched: string[] = []
vi.mock('../../lib/teamChat/boardDispatch', () => ({
  requestTaskDispatch: (_teamId: string, taskId: string) => {
    dispatched.push(taskId)
  },
}))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const { boardCreatePOST, boardGetGET, boardListGET, boardTaskLabelsPUT, boardUpdatePATCH } =
  await import('../board')
const { teamsDELETE } = await import('../teams')
const {
  teamLabelDELETE,
  teamLabelPATCH,
  teamLabelsGET,
  teamLabelsPOST,
  teamTaskPrefixGET,
  teamTaskPrefixPUT,
} = await import('../teamLabels')

function call(
  handler: (req: Request, res: Response) => void,
  over: Partial<Request> = {},
): { code: number; body: Record<string, unknown> } {
  let code = 200
  let body: Record<string, unknown> = {}
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: Record<string, unknown>) {
      body = b
      return this
    },
  } as unknown as Response
  handler(
    {
      params: {},
      query: {},
      body: {},
      headers: {},
      app: { locals: {} },
      ...over,
    } as unknown as Request,
    res,
  )
  return { code, body }
}

const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const TEAM = 'T'

let home: string
const prior = { home: process.env['HOME'], clawboo: process.env['CLAWBOO_HOME'] }

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-create-'))
  await mkdir(path.join(home, '.clawboo'), { recursive: true })
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  resetDb()
  dispatched.length = 0
  expect(getDbPath().startsWith(home)).toBe(true)
  getDb()
    .insert(teams)
    .values({ id: TEAM, name: 'Clawboo', icon: 'x', color: '#0', createdAt: 1, updatedAt: 1 })
    .run()
  getDb()
    .insert(agents)
    .values({ id: 'a1', name: 'Coder', gatewayId: 'a1', teamId: TEAM, createdAt: 1, updatedAt: 1 })
    .run()
})

afterEach(async () => {
  resetDb()
  for (const [k, v] of [
    ['HOME', prior.home],
    ['CLAWBOO_HOME', prior.clawboo],
  ] as const) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  await rm(home, { recursive: true, force: true })
})

type TaskRow = { id: string; identifier: string | null; priority: number; title: string }

describe('POST /api/board', () => {
  it('shows the readable id', () => {
    const { body } = call(boardCreatePOST, { body: { title: 'a', teamId: TEAM } })
    expect((body['task'] as TaskRow).identifier).toBe('CLA-1')
  })

  it('a retried draft returns the same task, starts one run, logs one create', () => {
    const body = { title: 'a', teamId: TEAM, assigneeAgentId: 'a1', idempotencyKey: 'draft-1' }
    const first = call(boardCreatePOST, { body, headers: DASHBOARD })
    const again = call(boardCreatePOST, { body, headers: DASHBOARD })
    expect((again.body['task'] as TaskRow).id).toBe((first.body['task'] as TaskRow).id)
    expect(first.body['deduplicated']).toBeUndefined()
    expect(again.body['deduplicated']).toBe(true)
    expect(dispatched).toHaveLength(1)
    expect(listEvents(getDb(), { kinds: ['task_created'] }).length).toBeLessThanOrEqual(1)
  })

  it('a key belongs to its team', () => {
    getDb()
      .insert(teams)
      .values({ id: 'U', name: 'Other', icon: 'x', color: '#0', createdAt: 1, updatedAt: 1 })
      .run()
    const a = call(boardCreatePOST, { body: { title: 'a', teamId: TEAM, idempotencyKey: 'k' } })
    const b = call(boardCreatePOST, { body: { title: 'a', teamId: 'U', idempotencyKey: 'k' } })
    expect((b.body['task'] as TaskRow).id).not.toBe((a.body['task'] as TaskRow).id)
  })

  it("a person's own creates skip the same-title check", () => {
    const body = { title: 'a', teamId: TEAM }
    const first = call(boardCreatePOST, { body })
    const second = call(boardCreatePOST, { body })
    expect((second.body['task'] as TaskRow).id).not.toBe((first.body['task'] as TaskRow).id)
  })

  it('a person can set Urgent; a caller that is not the dashboard stops at High', () => {
    const person = call(boardCreatePOST, {
      body: { title: 'a', teamId: TEAM, priority: 2 },
      headers: DASHBOARD,
    })
    expect((person.body['task'] as TaskRow).priority).toBe(2)
    const other = call(boardCreatePOST, { body: { title: 'b', teamId: TEAM, priority: 2 } })
    expect((other.body['task'] as TaskRow).priority).toBe(1)
  })
})

describe('PATCH /api/board/:taskId', () => {
  it('a person can raise a task to Urgent; a caller that is not the dashboard stops at High', () => {
    const t = createTask(getDb(), { title: 'a', teamId: TEAM })
    const params = { taskId: t.id }
    call(boardUpdatePATCH, { params, body: { priority: 2 } })
    expect(getTask(getDb(), t.id)?.priority).toBe(1)
    call(boardUpdatePATCH, { params, body: { priority: 2 }, headers: DASHBOARD })
    expect(getTask(getDb(), t.id)?.priority).toBe(2)
  })

  it("a person's cancel frees the child's slot, and the steps it takes with it", () => {
    const db = getDb()
    const parent = createTask(db, { title: 'p', teamId: TEAM })
    const child = (title: string): string => {
      const r = createCappedSubtask(db, parent.id, { title }, { maxChildren: 2 })
      if (!r.ok) throw new Error(r.reason)
      return r.task.id
    }
    const first = child('one')
    const second = child('two')
    linkDep(db, second, first)
    expect(createCappedSubtask(db, parent.id, { title: 'x' }, { maxChildren: 2 }).ok).toBe(false)
    call(boardUpdatePATCH, {
      params: { taskId: first },
      body: { status: 'cancelled' },
      headers: DASHBOARD,
    })
    expect(getTask(db, second)?.status).toBe('cancelled')
    expect(createCappedSubtask(db, parent.id, { title: 'x' }, { maxChildren: 2 }).ok).toBe(true)
    expect(createCappedSubtask(db, parent.id, { title: 'y' }, { maxChildren: 2 }).ok).toBe(true)
  })
})

describe('at boot', () => {
  it('gives tasks made before readable ids theirs, and a second boot changes nothing', () => {
    const db = getDb()
    db.insert(tasks)
      .values({ id: 'old', title: 'old', teamId: TEAM, createdAt: 5, updatedAt: 5 })
      .run()
    expect(getTask(db, 'old')?.identifier).toBeNull()
    resetDb()
    expect(getTask(getDb(), 'old')?.identifier).toBe('CLA-1')
    expect(getTask(getDb(), 'old')?.updatedAt).toBe(5)
    resetDb()
    expect(getTask(getDb(), 'old')?.identifier).toBe('CLA-1')
    expect(createTask(getDb(), { title: 'new', teamId: TEAM }).identifier).toBe('CLA-2')
  })
})

describe('the failure breaker and the team', () => {
  it('goes when the team goes', async () => {
    noteDelegationFailure(getDb(), TEAM, 'a1', 'task')
    let done = false
    await teamsDELETE(
      { params: { id: TEAM }, body: {}, headers: {} } as unknown as Request,
      {
        status() {
          return this
        },
        json() {
          done = true
          return this
        },
      } as unknown as Response,
    )
    expect(done).toBe(true)
    expect(readDelegationFailure(getDb(), TEAM, 'a1', 'task').failures).toBe(0)
  })
})

describe('the team task prefix', () => {
  const params = { id: TEAM }
  const put = (prefix: unknown, headers: Record<string, string> = DASHBOARD) =>
    call(teamTaskPrefixPUT, { params, body: { prefix }, headers })

  it('reads what the first task would take', () => {
    expect(call(teamTaskPrefixGET, { params }).body).toEqual({
      prefix: null,
      suggested: 'CLA',
      locked: false,
    })
  })

  it('a person sets it, and the first task uses it', () => {
    expect(put('clb').body['prefix']).toBe('CLB')
    const { body } = call(boardCreatePOST, { body: { title: 'a', teamId: TEAM } })
    expect((body['task'] as TaskRow).identifier).toBe('CLB-1')
  })

  it('only the dashboard may set it', () => {
    expect(put('CLB', {}).code).toBe(403)
    expect(call(teamTaskPrefixGET, { params }).body['prefix']).toBeNull()
  })

  it('cannot change after the first task', () => {
    createTask(getDb(), { title: 'a', teamId: TEAM })
    const r = put('NEW')
    expect(r.code).toBe(409)
    expect(r.body['error']).toBe('locked')
    expect(call(teamTaskPrefixGET, { params }).body['locked']).toBe(true)
  })

  it('refuses a bad shape, a prefix taken, and a team not there', () => {
    expect(put('x').code).toBe(400)
    expect(put(7).code).toBe(400)
    getDb()
      .insert(teams)
      .values({
        id: 'U',
        name: 'Other',
        icon: 'x',
        color: '#0',
        taskPrefix: 'OTH',
        createdAt: 1,
        updatedAt: 1,
      })
      .run()
    const taken = put('OTH')
    expect(taken.code).toBe(409)
    expect(taken.body['error']).toBe('taken')
    expect(call(teamTaskPrefixGET, { params: { id: 'ghost' } }).code).toBe(404)
    expect(
      call(teamTaskPrefixPUT, {
        params: { id: 'ghost' },
        body: { prefix: 'ABC' },
        headers: DASHBOARD,
      }).code,
    ).toBe(404)
  })

  it('a team rename changes no ids', () => {
    const t = createTask(getDb(), { title: 'a', teamId: TEAM })
    getDb().update(teams).set({ name: 'Renamed' }).where(eq(teams.id, TEAM)).run()
    expect(getTask(getDb(), t.id)?.identifier).toBe('CLA-1')
    expect(call(teamTaskPrefixGET, { params }).body['prefix']).toBe('CLA')
  })
})

describe('labels', () => {
  const params = { id: TEAM }
  const add = (name: unknown, headers: Record<string, string> = DASHBOARD) =>
    call(teamLabelsPOST, { params, body: { name }, headers })
  const labelId = (name: string): string => (add(name).body['label'] as { id: string }).id

  it('a person adds, renames and deletes a team label', () => {
    const id = labelId('Bug')
    expect(add('bug').code).toBe(409)
    expect(add('  ').code).toBe(400)
    expect(call(teamLabelsGET, { params }).body['labels']).toMatchObject([{ id, name: 'Bug' }])

    const renamed = call(teamLabelPATCH, {
      params: { ...params, labelId: id },
      body: { name: 'Defect' },
      headers: DASHBOARD,
    })
    expect((renamed.body['label'] as { name: string }).name).toBe('Defect')
    expect(
      call(teamLabelDELETE, { params: { ...params, labelId: id }, headers: DASHBOARD }).code,
    ).toBe(200)
    expect(call(teamLabelsGET, { params }).body['labels']).toEqual([])
  })

  it('only the dashboard may change them', () => {
    expect(add('Bug', {}).code).toBe(403)
    const id = labelId('Bug')
    expect(
      call(teamLabelPATCH, { params: { ...params, labelId: id }, body: { name: 'x' } }).code,
    ).toBe(403)
    expect(call(teamLabelDELETE, { params: { ...params, labelId: id } }).code).toBe(403)
  })

  it('a task carries its labels on the board list and on its own read', () => {
    const id = labelId('Bug')
    const t = createTask(getDb(), { title: 'a', teamId: TEAM })
    const plain = createTask(getDb(), { title: 'b', teamId: TEAM })
    const put = call(boardTaskLabelsPUT, {
      params: { taskId: t.id },
      body: { labelIds: [id] },
      headers: DASHBOARD,
    })
    expect(put.code).toBe(200)
    expect(put.body['labels']).toEqual([{ id, name: 'Bug' }])

    const list = call(boardListGET, { query: { teamId: TEAM } }).body['tasks'] as Array<
      TaskRow & { labels: unknown }
    >
    expect(list.find((x) => x.id === t.id)?.labels).toEqual([{ id, name: 'Bug' }])
    expect(list.find((x) => x.id === plain.id)?.labels).toEqual([])
    const one = call(boardGetGET, { params: { taskId: t.id } }).body['task'] as { labels: unknown }
    expect(one.labels).toEqual([{ id, name: 'Bug' }])
  })

  it('setting a task’s labels is the dashboard’s, and keeps to its team', () => {
    const id = labelId('Bug')
    const t = createTask(getDb(), { title: 'a', teamId: TEAM })
    const route = (headers: Record<string, string>, labelIds: unknown) =>
      call(boardTaskLabelsPUT, { params: { taskId: t.id }, body: { labelIds }, headers })
    expect(route({}, [id]).code).toBe(403)
    expect(route(DASHBOARD, 'nope').code).toBe(400)
    expect(route(DASHBOARD, ['someone-elses']).code).toBe(409)
    expect(
      call(boardTaskLabelsPUT, {
        params: { taskId: 'ghost' },
        body: { labelIds: [] },
        headers: DASHBOARD,
      }).code,
    ).toBe(404)
  })
})
