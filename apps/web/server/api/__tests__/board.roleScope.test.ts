// What a guest's task drawer shows when the task's tree reaches another team: a
// hand-off can file work on another team, under a main task or above a task, and
// a guest (lib/roles) sees only the tasks of their own teams. Sandboxes HOME and
// CLAWBOO_HOME so the database is a throwaway.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, createTask, teams } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { boardGetGET, boardListGET } from '../board'

function fakeRes(): { res: Response; body: () => unknown } {
  let body: unknown
  const res = {
    status() {
      return this
    },
    json(b: unknown) {
      body = b
      return this
    },
  } as unknown as Response
  return { res, body: () => body }
}

function req(taskId: string, guestTeams?: string[]): Request {
  return {
    params: { taskId },
    query: {},
    body: {},
    headers: {},
    ...(guestTeams ? { roleScope: { teams: new Set(guestTeams) } } : {}),
  } as unknown as Request
}

interface Detail {
  task: { waitingOnDetail?: { taskTitle?: string } }
  ancestors: Array<{ id: string }>
  subtasks?: Array<{ id: string }>
}

function detail(taskId: string, guestTeams?: string[]): Detail {
  const r = fakeRes()
  boardGetGET(req(taskId, guestTeams), r.res)
  return r.body() as Detail
}

describe('board REST: a guest sees only their teams in a task tree', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-role-scope-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    const db = getDb()
    const now = Date.now()
    for (const id of ['T', 'OTHER']) {
      db.insert(teams)
        .values({ id, name: id, icon: 'T', color: '#000', createdAt: now, updatedAt: now })
        .run()
    }
    db.insert(agents)
      .values({
        id: 'lead',
        name: 'Lead',
        gatewayId: 'lead',
        teamId: 'T',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it("leaves another team's parents out of a task's breadcrumb", () => {
    const db = getDb()
    const top = createTask(db, { title: 'Campaign', teamId: 'OTHER' }).id
    const mine = createTask(db, { title: 'Photos', teamId: 'T', parentTaskId: top }).id

    expect(detail(mine).ancestors.map((a) => a.id)).toContain(top)
    expect(detail(mine, ['T']).ancestors.map((a) => a.id)).not.toContain(top)
    expect(detail(mine, ['T', 'OTHER']).ancestors.map((a) => a.id)).toContain(top)
  })

  it("leaves another team's work out of a main task's list", () => {
    const db = getDb()
    const main = createTask(db, { title: 'Launch', teamId: 'T', mainTaskLead: 'lead' }).id
    const here = createTask(db, { title: 'Landing page', teamId: 'T', parentTaskId: main }).id
    const there = createTask(db, { title: 'Ads copy', teamId: 'OTHER', parentTaskId: main }).id

    const everyone = detail(main).subtasks?.map((t) => t.id) ?? []
    expect(everyone).toEqual(expect.arrayContaining([here, there]))
    expect(detail(main, ['T']).subtasks?.map((t) => t.id)).toEqual([here])
  })

  it('never tells a guest the title of a waited-on task on another team', () => {
    const db = getDb()
    // A wait can cross teams: a session bound to no team can set one.
    const secret = createTask(db, { title: 'Unannounced launch', teamId: 'OTHER' }).id
    const mine = createTask(db, {
      title: 'Photos',
      teamId: 'T',
      status: 'blocked',
      waitingOn: { kind: 'task', taskId: secret },
    }).id

    expect(detail(mine).task.waitingOnDetail?.taskTitle).toBe('Unannounced launch')
    expect(detail(mine, ['T']).task.waitingOnDetail?.taskTitle).toBe('')
    expect(detail(mine, ['T', 'OTHER']).task.waitingOnDetail?.taskTitle).toBe('Unannounced launch')

    const listed = (guestTeams?: string[]) => {
      const r = fakeRes()
      boardListGET({ ...req(mine, guestTeams), params: {} } as unknown as Request, r.res)
      const rows = (
        r.body() as { tasks: Array<{ id: string; waitingOnDetail?: { taskTitle?: string } }> }
      ).tasks
      return rows.find((t) => t.id === mine)?.waitingOnDetail?.taskTitle
    }
    expect(listed()).toBe('Unannounced launch')
    expect(listed(['T'])).toBe('')
  })
})
