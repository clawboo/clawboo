// What a person can do to a request's main task on the board: close it with its work,
// comment on it, reopen it. And what they cannot: run it, retry it, or give it to an
// agent, since a main task holds a request and runs nothing. The engine's own part is
// in the cascade contract; here it is recorded, so each route's decision is what shows.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  activitySeqOf,
  agents,
  closeMainTask,
  createHandOffUnderRequest,
  getComments,
  getTask,
  closeMainTask as closeRequest,
  listEvents,
  listExecutions,
  listPendingReportUps,
  markTaskRead,
  placePause,
  readerOfPerson,
  taskReadStates,
  taskTreeRootId,
  listWaitingTaskWakes,
  mainTaskState,
  teams,
  updateStatus,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const moved: Array<{ taskId: string; to: string }> = []
const commented: Array<{ taskId: string; words: string }> = []
let pumps = 0
let commentGoes = true
vi.mock('../../lib/teamChat/teamOrchestrator', () => {
  const orchestrator = () => ({
    personMovedTask: async (taskId: string, to: string) => {
      moved.push({ taskId, to })
    },
    personCommentedOnMainTask: async (taskId: string, words: string) => {
      commented.push({ taskId, words })
      return commentGoes
    },
    pump: async () => {
      pumps += 1
    },
  })
  return {
    getTeamOrchestrator: orchestrator,
    getTaskOrchestrator: orchestrator,
    hasTeamOrchestrator: () => true,
    hasTaskOrchestrator: () => true,
  }
})
const stopped: string[] = []
vi.mock('../../lib/runStops', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/runStops')>()),
  stopTaskRuns: (taskId: string) => {
    stopped.push(taskId)
    return 0
  },
}))
const dispatched: string[] = []
vi.mock('../../lib/teamChat/boardDispatch', () => ({
  requestTaskDispatch: (_teamId: string, taskId: string) => dispatched.push(taskId),
}))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const {
  boardAssignPOST,
  boardClaimPOST,
  boardCommentPOST,
  boardCreatePOST,
  boardExecutionCreatePOST,
  boardRetryPOST,
  boardUpdatePATCH,
} = await import('../board')
const { boardReopenPOST } = await import('../boardPerson')

function mockRes(): {
  res: Response
  statusCode: () => number
  body: () => { cancelledDependents: Array<{ id: string }>; error?: string; delivery?: unknown }
} {
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
  return { res, statusCode: () => code, body: () => payload as never }
}
const DASHBOARD_HEADERS = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const req = (over: Partial<Request> = {}): Request =>
  ({
    params: {},
    query: {},
    body: {},
    headers: DASHBOARD_HEADERS,
    app: { locals: {} },
    get: () => undefined,
    ...over,
  }) as unknown as Request

const TEAM = 'T'
const LEAD = 'lead'

describe('a person and a request’s main task', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-main-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    moved.length = 0
    commented.length = 0
    stopped.length = 0
    dispatched.length = 0
    commentGoes = true
    pumps = 0
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: TEAM, name: 'Team', icon: 'x', color: '#000', createdAt: now, updatedAt: now })
      .run()
    for (const id of [LEAD, 'worker'])
      db.insert(agents)
        .values({ id, name: id, gatewayId: id, teamId: TEAM, createdAt: now, updatedAt: now })
        .run()
  })

  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  function request(): { mainId: string; first: string; second: string } {
    const db = getDb()
    const make = (title: string) => {
      const r = createHandOffUnderRequest(
        db,
        { title: 'Build it', description: 'Build it', leadAgentId: LEAD, key: 'main:T:d1' },
        {
          title,
          teamId: TEAM,
          sourceDelegationId: `d1:deleg:agent:worker:reflectTo:${LEAD}`,
        },
      )
      if (!r.ok) throw new Error(r.reason)
      return r.task
    }
    const first = make('first')
    const second = make('second')
    return { mainId: first.parentTaskId as string, first: first.id, second: second.id }
  }

  it('a cancel leaves no sub-task running: each is cancelled and its run stopped', () => {
    const { mainId, first, second } = request()
    const db = getDb()
    updateStatus(db, first, 'in_progress')
    const r = mockRes()
    boardUpdatePATCH(req({ params: { taskId: mainId }, body: { status: 'cancelled' } }), r.res)
    expect(r.statusCode()).toBe(200)
    expect(getTask(db, mainId)?.status).toBe('cancelled')
    expect(getTask(db, first)?.status).toBe('cancelled')
    expect(getTask(db, second)?.status).toBe('cancelled')
    expect(mainTaskState(db, mainId)?.openSubtasks).toBe(0)
    expect(stopped).toEqual(expect.arrayContaining([first, second]))
    expect(moved).toEqual(
      expect.arrayContaining([
        { taskId: first, to: 'cancelled' },
        { taskId: second, to: 'cancelled' },
      ]),
    )
    expect(r.body().cancelledDependents.map((d: { id: string }) => d.id)).toEqual(
      expect.arrayContaining([first, second]),
    )
  })

  it('Done with work still open ends that work as well, and says which', () => {
    const { mainId, first, second } = request()
    const db = getDb()
    updateStatus(db, first, 'in_progress')
    updateStatus(db, first, 'done')
    const r = mockRes()
    boardUpdatePATCH(req({ params: { taskId: mainId }, body: { status: 'done' } }), r.res)
    expect(r.statusCode()).toBe(200)
    expect(getTask(db, mainId)?.status).toBe('done')
    expect(getTask(db, first)?.status).toBe('done')
    expect(getTask(db, second)?.status).toBe('cancelled')
    expect(r.body().cancelledDependents.map((d: { id: string }) => d.id)).toEqual([second])
  })

  describe('and who is asking', () => {
    const noPerson = (over: Partial<Request>) => req({ headers: {}, ...over })

    it('a caller that is no person cannot close it, and the work under it stays', () => {
      const { mainId, first, second } = request()
      const db = getDb()
      updateStatus(db, first, 'in_progress')
      const r = mockRes()
      boardUpdatePATCH(noPerson({ params: { taskId: mainId }, body: { status: 'done' } }), r.res)
      expect(r.statusCode()).toBe(409)
      expect(r.body().error).toBe('main_task')
      expect(getTask(db, mainId)?.status).toBe('in_progress')
      expect(getTask(db, first)?.status).toBe('in_progress')
      expect(getTask(db, second)?.status).toBe('todo')
      expect(stopped).toEqual([])
    })

    it('a caller that is no person cannot reopen it', async () => {
      const { mainId } = request()
      const db = getDb()
      closeRequest(db, mainId, 'done')
      const r = mockRes()
      await boardReopenPOST(noPerson({ params: { taskId: mainId }, body: {} }), r.res)
      expect(r.statusCode()).toBe(403)
      expect(getTask(db, mainId)?.status).toBe('done')
      expect(listPendingReportUps(db, TEAM, null)).toEqual([])
    })

    it('a caller that is no person cannot speak to the lead as one', async () => {
      const { mainId } = request()
      const r = mockRes()
      await boardCommentPOST(
        noPerson({ params: { taskId: mainId }, body: { body: 'Stop that', authorType: 'user' } }),
        r.res,
      )
      expect(commented).toEqual([])
      expect(getComments(getDb(), mainId).at(-1)).toMatchObject({ authorType: 'agent' })
    })

    it('a person’s reopen is on the record as theirs, and moves it to where it waits', async () => {
      const { mainId } = request()
      const db = getDb()
      closeRequest(db, mainId, 'cancelled')
      const r = mockRes()
      await boardReopenPOST(req({ params: { taskId: mainId }, body: {} }), r.res)
      expect(r.statusCode()).toBe(200)
      expect(getTask(db, mainId)?.status).toBe('in_progress')
      const data = JSON.parse(
        listEvents(db, { kinds: ['status_changed'] })
          .filter((e) => e.taskId === mainId)
          .at(-1)?.data ?? '{}',
      ) as { to?: string; reason?: string; actor?: { kind: string } }
      expect(data).toMatchObject({
        to: 'in_progress',
        reason: 'reopened',
        actor: { kind: 'person' },
      })
    })

    it('a person’s close and each cancel it causes are on the record as theirs', () => {
      const { mainId, second } = request()
      const db = getDb()
      const r = mockRes()
      boardUpdatePATCH(req({ params: { taskId: mainId }, body: { status: 'cancelled' } }), r.res)
      const moves = listEvents(db, { kinds: ['status_changed'] })
      const dataOf = (taskId: string) =>
        JSON.parse(moves.find((e) => e.taskId === taskId)?.data ?? '{}') as {
          actor?: { kind: string }
          by?: string
          reason?: string
        }
      expect(dataOf(mainId)).toMatchObject({ by: 'person', actor: { kind: 'person' } })
      expect(dataOf(second)).toMatchObject({
        by: 'person',
        reason: 'request_closed',
        actor: { kind: 'person' },
      })
    })

    it('a request that closes on its lead’s summary names no one as having closed it', async () => {
      const { mainId, first, second } = request()
      const db = getDb()
      for (const id of [first, second]) {
        updateStatus(db, id, 'in_progress')
        updateStatus(db, id, 'done')
      }
      const { createServerBoardClient } = await import('../../lib/teamChat/serverBoardClient')
      expect(await createServerBoardClient(db).closeMainTask(mainId, 'done')).toBe(true)
      const data = JSON.parse(
        listEvents(db, { kinds: ['status_changed'] }).find((e) => e.taskId === mainId)?.data ??
          '{}',
      ) as { actor?: unknown; by?: unknown; reason?: string }
      expect(data.reason).toBe('request_closed')
      expect(data.actor).toBeUndefined()
      expect(data.by).toBeUndefined()
    })

    it('records who asked from the person named on the message', () => {
      const db = getDb()
      const r = createHandOffUnderRequest(
        db,
        {
          title: 'Ask',
          description: 'Ask',
          leadAgentId: LEAD,
          key: 'main:T:d9',
          requestedBy: { id: 'p1', name: 'Pat', role: null },
        },
        { title: 'part', teamId: TEAM, sourceDelegationId: 'd9:deleg:agent:worker:reflectTo:lead' },
      )
      if (!r.ok) throw new Error(r.reason)
      expect(JSON.parse(r.mainTask!.requestedBy!)).toEqual({ id: 'p1', name: 'Pat', role: null })
      expect(r.mainTask?.assigneePersonId).toBeNull()
    })
  })

  describe('and a pause', () => {
    it('a comment says it waits for the resume, and goes to the lead then', async () => {
      const { mainId } = request()
      placePause(getDb(), { kind: 'task_tree', id: mainId })
      const r = mockRes()
      await boardCommentPOST(
        req({ params: { taskId: mainId }, body: { body: 'Add a logo', authorType: 'user' } }),
        r.res,
      )
      expect(r.body().delivery).toEqual({ status: 'queued', agentId: LEAD, reason: 'paused' })
      expect(commented).toEqual([{ taskId: mainId, words: 'Add a logo' }])
    })

    it('a Reopen says so too', async () => {
      const { mainId } = request()
      const db = getDb()
      closeRequest(db, mainId, 'done')
      placePause(db, { kind: 'task_tree', id: mainId })
      const r = mockRes()
      await boardReopenPOST(req({ params: { taskId: mainId }, body: {} }), r.res)
      expect(r.body().delivery).toEqual({ status: 'queued', agentId: LEAD, reason: 'paused' })
    })

    it('a pause named on any sub-task lands on the main task', () => {
      const { mainId, second } = request()
      expect(taskTreeRootId(getDb(), second)).toBe(mainId)
    })
  })

  describe('and what is news', () => {
    const local = readerOfPerson(null)
    const unread = (taskId: string): boolean =>
      taskReadStates(getDb(), local, { taskId }).get(taskId)?.unread === true

    it('a person’s own close is not news to them, nor is what it cancels', () => {
      const { mainId, second } = request()
      const db = getDb()
      markTaskRead(db, local, mainId, activitySeqOf(db, mainId))
      markTaskRead(db, local, second, activitySeqOf(db, second))
      const r = mockRes()
      boardUpdatePATCH(req({ params: { taskId: mainId }, body: { status: 'cancelled' } }), r.res)
      expect(r.statusCode()).toBe(200)
      expect(unread(mainId)).toBe(false)
      expect(unread(second)).toBe(false)
    })

    it('the server closing it after the summary is news', () => {
      const { mainId, first, second } = request()
      const db = getDb()
      for (const id of [first, second]) {
        updateStatus(db, id, 'in_progress')
        updateStatus(db, id, 'done')
      }
      markTaskRead(db, local, mainId, activitySeqOf(db, mainId))
      expect(unread(mainId)).toBe(false)
      expect(closeRequest(db, mainId, 'done')).toBe(true)
      expect(unread(mainId)).toBe(true)
    })

    it('a request has no run of its own, marked as the engine’s or otherwise', () => {
      const { mainId, first } = request()
      const db = getDb()
      updateStatus(db, first, 'in_progress')
      updateStatus(db, first, 'done')
      expect(listExecutions(db, mainId)).toEqual([])
    })
  })

  it('a close the board refuses leaves the work under it alone', () => {
    const { mainId, first, second } = request()
    const db = getDb()
    updateStatus(db, first, 'in_progress')
    const r = mockRes()
    boardUpdatePATCH(
      req({
        params: { taskId: mainId },
        body: { status: 'cancelled', completedAt: Date.now() + 60 * 60_000 },
      }),
      r.res,
    )
    expect(r.statusCode()).toBe(400)
    expect(r.body().error).toBe('invalid_completed_at')
    expect(getTask(db, mainId)?.status).toBe('in_progress')
    expect(getTask(db, first)?.status).toBe('in_progress')
    expect(getTask(db, second)?.status).toBe('todo')
    expect(stopped).toEqual([])
    expect(moved).toEqual([])
  })

  it('a follow-up under a closed request opens it again, so it does not run hidden', () => {
    const { mainId, first, second } = request()
    const db = getDb()
    for (const id of [first, second]) {
      updateStatus(db, id, 'in_progress')
      updateStatus(db, id, 'done')
    }
    closeMainTask(db, mainId, 'done')
    const r = mockRes()
    boardCreatePOST(
      req({
        body: {
          title: 'Follow up: first',
          teamId: TEAM,
          parentTaskId: first,
          assigneeAgentId: 'worker',
        },
      }),
      r.res,
    )
    expect(r.statusCode()).toBe(200)
    expect(getTask(db, mainId)?.status).toBe('in_progress')
    expect(getTask(db, mainId)?.completedAt).toBeNull()
  })

  it('a move to anything else is refused and changes nothing', () => {
    const { mainId, first } = request()
    for (const status of ['todo', 'blocked', 'backlog', 'in_review']) {
      const r = mockRes()
      boardUpdatePATCH(req({ params: { taskId: mainId }, body: { status } }), r.res)
      expect(r.statusCode()).toBe(409)
      expect(r.body().error).toBe('main_task')
    }
    expect(getTask(getDb(), mainId)?.status).toBe('in_progress')
    expect(getTask(getDb(), first)?.status).toBe('todo')
  })

  it('cannot be retried, assigned, claimed or given a run', () => {
    const { mainId } = request()
    const retry = mockRes()
    boardRetryPOST(req({ params: { taskId: mainId } }), retry.res)
    expect(retry.statusCode()).toBe(409)
    const assign = mockRes()
    boardAssignPOST(req({ params: { taskId: mainId }, body: { agentId: 'worker' } }), assign.res)
    expect(assign.statusCode()).toBe(409)
    const claim = mockRes()
    boardClaimPOST(
      req({ params: { taskId: mainId }, body: { assigneeAgentId: 'worker' } }),
      claim.res,
    )
    expect(claim.statusCode()).toBe(409)
    const exec = mockRes()
    boardExecutionCreatePOST(
      req({ params: { taskId: mainId }, body: { executorType: 'codex' } }),
      exec.res,
    )
    expect(exec.statusCode()).toBe(409)
    expect(listExecutions(getDb(), mainId)).toEqual([])
    expect(dispatched).toEqual([])
    expect(getTask(getDb(), mainId)?.sourceDelegationId).toBeNull()
  })

  it('a person’s comment goes to the lead, with no wake on a task that cannot run', async () => {
    const { mainId } = request()
    const r = mockRes()
    await boardCommentPOST(
      req({
        params: { taskId: mainId },
        body: { body: 'Add a logo too', authorType: 'user' },
      }),
      r.res,
    )
    expect(r.body().delivery).toEqual({ status: 'woke-agent', agentId: LEAD })
    expect(commented).toEqual([{ taskId: mainId, words: 'Add a logo too' }])
    expect(listWaitingTaskWakes(getDb(), { taskId: mainId })).toEqual([])
    expect(getTask(getDb(), mainId)?.status).toBe('in_progress')
  })

  it('a comment on a closed request says so', async () => {
    const { mainId } = request()
    closeMainTask(getDb(), mainId, 'done')
    const r = mockRes()
    await boardCommentPOST(
      req({ params: { taskId: mainId }, body: { body: 'one more', authorType: 'user' } }),
      r.res,
    )
    expect(r.body().delivery).toEqual({
      status: 'not-delivered',
      agentId: LEAD,
      reason: 'finished',
    })
    expect(commented).toEqual([])
  })

  it('Reopen puts it back to where it waits and tells its lead, with the person’s words', async () => {
    const { mainId, first, second } = request()
    const db = getDb()
    for (const id of [first, second]) updateStatus(db, id, 'cancelled')
    closeMainTask(db, mainId, 'cancelled')
    const r = mockRes()
    await boardReopenPOST(
      req({ params: { taskId: mainId }, body: { comment: 'Please try again' } }),
      r.res,
    )
    expect(r.statusCode()).toBe(200)
    const row = getTask(db, mainId)!
    expect(row.status).toBe('in_progress')
    expect(row.completedAt).toBeNull()
    // In the reopen's own write, so nothing can read the request as having no one to
    // answer it: the engine's own first pass runs before anything else it is told.
    const [told] = listPendingReportUps(db, TEAM, null)
    expect(told?.taskId).toBe(mainId)
    expect(JSON.parse(told!.payload)).toMatchObject({
      summary: 'Please try again',
      outcome: 'person_comment',
      toAgentId: LEAD,
    })
    expect(pumps).toBe(1)
    expect(r.body().delivery).toEqual({ status: 'woke-agent', agentId: LEAD })
    expect(getComments(db, mainId).map((c) => c.body)).toContain('Please try again')
    expect(listWaitingTaskWakes(db, { taskId: mainId })).toEqual([])
    expect(dispatched).toEqual([])
  })

  it('Reopen with no words still tells its lead', async () => {
    const { mainId } = request()
    closeMainTask(getDb(), mainId, 'done')
    const r = mockRes()
    await boardReopenPOST(req({ params: { taskId: mainId }, body: {} }), r.res)
    expect(r.statusCode()).toBe(200)
    expect(JSON.parse(listPendingReportUps(getDb(), TEAM, null)[0]!.payload)).toMatchObject({
      summary: 'A person reopened this request.',
    })
    expect(pumps).toBe(1)
  })
})
