// What a guest's task drawer shows when the task's tree reaches another team: a
// hand-off can file work on another team, under a main task or above a task, and
// a guest (lib/roles) sees only the tasks of their own teams. Sandboxes HOME and
// CLAWBOO_HOME so the database is a throwaway.

import { EventEmitter } from 'node:events'
import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { addComment, agents, createTask, tasks, teamChat, teams, updateStatus } from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { roleGuard } from '../../lib/roles/guard'
import { HIDDEN_NOTE } from '../../lib/roles/redact'
import type { PersonAccess } from '../../lib/roles/policy'
import { ROUTE_RULES } from '../../lib/roles/rules'
import { reflectToRoom } from '../../lib/teamChat/reflect'
import { publishBoardChange } from '../../lib/teamChat/boardChangeBus'
import { boardGetGET, boardLinkDepPOST, boardListGET } from '../board'
import { teamChatGET } from '../teamChat'
import { teamChatStreamGET } from '../teamChatStream'

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
  task: { waitingOn?: string | null; waitingOnDetail?: { taskTitle?: string } }
  comments: Array<{ body: string }>
  ancestors: Array<{ id: string }>
  subtasks?: Array<{ id: string }>
}

function detail(taskId: string, guestTeams?: string[]): Detail {
  const r = fakeRes()
  boardGetGET(req(taskId, guestTeams), r.res)
  return r.body() as Detail
}

/** A guest of team T, until an hour from now. */
function guestAccess(): PersonAccess {
  return {
    roles: ['guest'],
    approve: false,
    teams: ['T'],
    until: Math.floor(Date.now() / 1000) + 3600,
    label: null,
    service: false,
  }
}

const operator: PersonAccess = {
  roles: ['operator'],
  approve: false,
  teams: null,
  until: null,
  label: null,
  service: false,
}

/** A request the way the server serves it: the route's own guard, then its handler. */
function serve(
  route: string,
  handler: (req: Request, res: Response) => void,
  access: PersonAccess,
  parts: { params?: Record<string, string>; query?: Record<string, string> },
): unknown {
  const r = fakeRes()
  const res = Object.assign(r.res, { set: () => res, on: () => res, writableEnded: false })
  const req = {
    params: parts.params ?? {},
    query: parts.query ?? {},
    body: {},
    headers: {},
    person: { id: 'p-1', name: 'Ada', role: null },
    access,
    app: { locals: { rolesMode: 'enforce' } },
  } as unknown as Request
  roleGuard(ROUTE_RULES[route]!)(req, res, () => handler(req, res))
  return r.body()
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

  it("never copies a waited-on task's title from another team into the waiting task", () => {
    const db = getDb()
    // A wait can cross teams: a session bound to no team can set one.
    const secret = createTask(db, { title: 'Unannounced launch', teamId: 'OTHER' }).id
    const mine = createTask(db, {
      title: 'Photos',
      teamId: 'T',
      status: 'blocked',
      waitingOn: { kind: 'task', taskId: secret },
    }).id
    // The same on one team, which names what it waited on.
    const brief = createTask(db, { title: 'Write the brief', teamId: 'T' }).id
    const copy = createTask(db, {
      title: 'Copy',
      teamId: 'T',
      status: 'blocked',
      waitingOn: { kind: 'task', taskId: brief },
    }).id
    for (const id of [secret, brief]) {
      expect(updateStatus(db, id, 'in_progress').ok).toBe(true)
      expect(updateStatus(db, id, 'done', { actor: 'person' }).ok).toBe(true)
    }

    const seen = detail(mine, ['T'])
    const said = [...seen.comments.map((c) => c.body), seen.task.waitingOn ?? ''].join('\n')
    expect(said).toContain('on another team, is done')
    expect(said).not.toContain('Unannounced launch')
    expect(
      detail(copy, ['T'])
        .comments.map((c) => c.body)
        .join('\n'),
    ).toContain('Write the brief')
  })

  it("never names another team's task in this team's room when a task comes to depend on it", () => {
    const db = getDb()
    const secret = createTask(db, { title: 'Unannounced launch', teamId: 'OTHER' }).id
    const brief = createTask(db, { title: 'Write the brief', teamId: 'T' }).id
    const mine = createTask(db, { title: 'Photos', teamId: 'T' }).id
    for (const dependsOnTaskId of [secret, brief]) {
      const r = fakeRes()
      boardLinkDepPOST(
        {
          params: { taskId: mine },
          body: { dependsOnTaskId },
          query: {},
          headers: {},
        } as unknown as Request,
        r.res,
      )
      expect(r.body()).toEqual({ ok: true })
    }
    const room = db
      .select({ body: teamChat.body })
      .from(teamChat)
      .where(eq(teamChat.teamId, 'T'))
      .all()
      .map((m) => m.body)
      .join('\n')
    expect(room).toContain('now depends on "Write the brief"')
    expect(room).toContain('now depends on a task on another team')
    expect(room).not.toContain('Unannounced launch')
  })

  it("hides another team's title in rows the board stored before, from a guest only", () => {
    const db = getDb()
    createTask(db, { title: 'Unannounced launch', teamId: 'OTHER' })
    createTask(db, { title: 'Write the brief', teamId: 'T' })
    // Rows as the board wrote them before a release note left other teams' titles out.
    const old = (title: string) =>
      `“${title}”, the task this waited on, is done, and nothing started this one again. Retry it or decide what happens next.`
    const mine = createTask(db, {
      title: 'Photos',
      teamId: 'T',
      status: 'blocked',
      // As releaseWaiterTx stores it: the board's own reason, with no `by`.
      waitingOn: { kind: 'person', need: old('Unannounced launch') },
    }).id
    addComment(db, mine, old('Unannounced launch'), 'system', null, { kind: 'note' })
    addComment(db, mine, old('Write the brief'), 'system', null, { kind: 'note' })
    reflectToRoom(db, 'T', 'Task "Photos" now depends on "Unannounced launch".')

    const guest = guestAccess()

    const read = (access: PersonAccess) =>
      JSON.stringify([
        serve('GET /api/board/:taskId', boardGetGET, access, { params: { taskId: mine } }),
        serve('GET /api/board', boardListGET, access, {}),
        serve('GET /api/team-chat', teamChatGET, access, { query: { teamId: 'T' } }),
      ])

    const asGuest = read(guest)
    expect(asGuest).not.toContain('Unannounced launch')
    expect(asGuest).toContain('The task this waited on, on another team, is done')
    expect(asGuest).toContain('now depends on a task on another team')
    // Their own team's title stays.
    expect(asGuest).toContain('Write the brief')

    const asOperator = read(operator)
    expect(asOperator).toContain('“Unannounced launch”, the task this waited on')
    expect(asOperator).toContain('now depends on \\"Unannounced launch\\"')
  })

  it('hides all of a title of another team that holds quotes of its own, in stored notes', () => {
    const db = getDb()
    createTask(db, { title: 'Plan ”Secret” notes', teamId: 'OTHER' })
    createTask(db, { title: 'Launch "Acquisition" plan', teamId: 'OTHER' })
    createTask(db, { title: 'Write the brief', teamId: 'T' })
    createTask(db, { title: 'Menu ”draft” v2', teamId: 'T' })
    // Notes as the board wrote them before titles were quoted safely.
    const list =
      '“Write the brief”, “Plan ”Secret” notes” did not finish. Retry them, or mark this task done.'
    const listed = createTask(db, {
      title: 'Launch day',
      teamId: 'T',
      status: 'blocked',
      waitingOn: { kind: 'person', need: list, by: 'agent', untilSubtasks: true },
    }).id
    // A long list cut at 1000 characters, inside a title just after one of its quotes.
    const head = Array.from({ length: 50 }, () => '“Write the brief”').join(', ') + ', '
    const cut = `${head}“Plan ”Secr`.padStart(1000, ' ')
    expect(cut).toHaveLength(1000)
    const cutShort = createTask(db, {
      title: 'Big launch',
      teamId: 'T',
      status: 'blocked',
      waitingOn: { kind: 'person', need: cut, by: 'agent', untilSubtasks: true },
    }).id
    // The note from the review: one title holding a closing and then an opening quote.
    const mixed = createTask(db, {
      title: 'Spring menu',
      teamId: 'T',
      status: 'blocked',
      waitingOn: {
        kind: 'person',
        need: '“Plan ”Secret “notes” did not finish. Retry them, or mark this task done.',
        untilSubtasks: true,
      },
    }).id
    addComment(
      db,
      listed,
      '“Plan ”Secret” notes”, the task this waited on, is done.',
      'system',
      null,
      {
        kind: 'note',
      },
    )
    addComment(db, listed, '“Menu ”draft” v2”, the task this waited on, is done.', 'system', null, {
      kind: 'note',
    })
    reflectToRoom(db, 'T', 'Task "Launch day" now depends on "Launch "Acquisition" plan".')

    const read = (access: PersonAccess) =>
      JSON.stringify([
        serve('GET /api/board/:taskId', boardGetGET, access, { params: { taskId: listed } }),
        serve('GET /api/board/:taskId', boardGetGET, access, { params: { taskId: cutShort } }),
        serve('GET /api/board/:taskId', boardGetGET, access, { params: { taskId: mixed } }),
        serve('GET /api/board', boardListGET, access, {}),
        serve('GET /api/team-chat', teamChatGET, access, { query: { teamId: 'T' } }),
      ])

    const asGuest = read(guestAccess())
    for (const part of ['Secret', 'Secr', 'notes”', 'Acquisition']) {
      expect(asGuest).not.toContain(part)
    }
    expect(asGuest).toContain('now depends on a task on another team.')
    // Their own title, quotes and all, still shows.
    expect(asGuest).toContain('“Menu ”draft” v2”, the task this waited on, is done.')
    // A note that cannot be read strictly is hidden whole.
    expect(asGuest).toContain(HIDDEN_NOTE)

    const asOperator = read(operator)
    for (const part of [
      '“Plan ”Secret” notes”',
      'Secr',
      'Launch \\"Acquisition\\" plan',
      '“Plan ”Secret “notes” did not finish',
    ]) {
      expect(asOperator).toContain(part)
    }
  })

  it("keeps a waited-on task's title off a guest's live board frame unless it is theirs", () => {
    const db = getDb()
    const secret = createTask(db, { title: 'Unannounced launch', teamId: 'OTHER' }).id
    const mine = createTask(db, {
      title: 'Photos',
      teamId: 'T',
      status: 'blocked',
      waitingOn: { kind: 'task', taskId: secret },
    }).id
    const row = db.select().from(tasks).where(eq(tasks.id, mine)).get()!

    const frames = (teams: string[] | null): string => {
      const req = Object.assign(new EventEmitter(), {
        params: { id: 'T' },
        query: {},
        headers: {},
        ...(teams ? { roleScope: { teams: new Set(teams) } } : {}),
      }) as unknown as Request
      let written = ''
      const res = Object.assign(new EventEmitter(), {
        writeHead: () => res,
        write: (chunk: string) => {
          written += chunk
          return true
        },
        status: () => res,
        json: () => res,
      }) as unknown as Response
      teamChatStreamGET(req, res)
      publishBoardChange('T', {
        id: mine,
        status: 'blocked',
        waitingOn: row.waitingOn,
        waitingOnDetail: { taskTitle: 'Unannounced launch' },
      } as Parameters<typeof publishBoardChange>[1])
      ;(req as unknown as EventEmitter).emit('close')
      return written.split('event: board\n')[1] ?? ''
    }

    const asGuest = frames(['T'])
    expect(asGuest).toContain('"waitingOnDetail":{"taskTitle":""}')
    expect(asGuest).not.toContain('Unannounced launch')
    expect(frames(['T', 'OTHER'])).toContain('Unannounced launch')
    expect(frames(null)).toContain('Unannounced launch')
  })
})
