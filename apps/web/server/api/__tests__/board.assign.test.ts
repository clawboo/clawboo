// A person handing work straight to one agent: POST /api/board with an assignee,
// POST /api/board/:id/retry and POST /api/board/:id/assign. The dispatch itself
// (the team orchestrator claiming and delivering) is covered by the cascade
// contract; here it is replaced by a recorder so each route's DECISION is what is
// asserted: what it binds, what it moves, and whether it asks for a run at all.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { delegationTargetOf, isHumanAssignment } from '@clawboo/board-core'
import {
  agents,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getComments,
  getTask,
  teams,
  updateStatus,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dispatched: Array<{ teamId: string; taskId: string }> = []
vi.mock('../../lib/teamChat/boardDispatch', () => ({
  requestTaskDispatch: (teamId: string, taskId: string) => {
    dispatched.push({ teamId, taskId })
  },
}))

const { getDb, resetDb } = await import('../../lib/db')
const { boardAssignPOST, boardCreatePOST, boardGetGET, boardListGET, boardRetryPOST } =
  await import('../board')

function mockRes(): { res: Response; statusCode: () => number; body: () => unknown } {
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
  return { res, statusCode: () => code, body: () => payload }
}
const req = (over: Partial<Request> = {}): Request =>
  ({ params: {}, query: {}, body: {}, app: { locals: {} }, ...over }) as unknown as Request

type TaskBody = {
  task: { id: string; status: string; sourceDelegationId: string | null; attention: unknown }
}

const TEAM = 'T'
const OTHER_TEAM = 'U'

describe('board: handing a task to one agent', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-assign-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    dispatched.length = 0
    const db = getDb()
    const now = Date.now()
    for (const [id, name] of [
      [TEAM, 'Team T'],
      [OTHER_TEAM, 'Team U'],
    ] as const) {
      db.insert(teams)
        .values({ id, name, icon: '🚀', color: '#e94560', createdAt: now, updatedAt: now })
        .run()
    }
    const agent = (id: string, name: string, teamId: string, archivedAt: number | null = null) =>
      db
        .insert(agents)
        .values({ id, name, gatewayId: id, teamId, archivedAt, createdAt: now, updatedAt: now })
        .run()
    agent('coder', 'Coder', TEAM)
    agent('writer', 'Writer', TEAM)
    agent('gone', 'Gone', TEAM, now)
    agent('outsider', 'Outsider', OTHER_TEAM)
  })

  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory that
    // still holds an open file.
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  describe('POST /api/board with an assignee', () => {
    it('binds the task to that agent and asks for it to run now', () => {
      const r = mockRes()
      boardCreatePOST(
        req({ body: { title: 'Draft the launch post', teamId: TEAM, assigneeAgentId: 'coder' } }),
        r.res,
      )
      expect(r.statusCode()).toBe(200)
      const { task } = r.body() as TaskBody
      expect(task.status).toBe('todo')
      expect(delegationTargetOf(task.sourceDelegationId)).toBe('coder')
      expect(isHumanAssignment(task.sourceDelegationId)).toBe(true)
      expect(task.attention).toBeNull() // queued for its agent: nothing needs the person
      expect(dispatched).toEqual([{ teamId: TEAM, taskId: task.id }])
    })

    it('a backlog task is bound but left parked', () => {
      const r = mockRes()
      boardCreatePOST(
        req({
          body: { title: 'Later', teamId: TEAM, assigneeAgentId: 'coder', status: 'backlog' },
        }),
        r.res,
      )
      expect((r.body() as TaskBody).task.status).toBe('backlog')
      expect(dispatched).toEqual([])
    })

    it('refuses an agent outside the task’s team, an archived one, or a missing team', () => {
      for (const body of [
        { title: 'x', teamId: TEAM, assigneeAgentId: 'outsider' },
        { title: 'x', teamId: TEAM, assigneeAgentId: 'gone' },
        { title: 'x', teamId: TEAM, assigneeAgentId: 'nobody' },
      ]) {
        const r = mockRes()
        boardCreatePOST(req({ body }), r.res)
        expect(r.statusCode()).toBe(400)
        expect(r.body()).toMatchObject({ error: 'agent_not_in_team' })
      }
      const noTeam = mockRes()
      boardCreatePOST(req({ body: { title: 'x', assigneeAgentId: 'coder' } }), noTeam.res)
      expect(noTeam.statusCode()).toBe(400)
      expect(noTeam.body()).toMatchObject({ error: 'team_required' })
      expect(dispatched).toEqual([])
    })

    it('without an assignee, nothing is dispatched and the card says it is unassigned', () => {
      const r = mockRes()
      boardCreatePOST(req({ body: { title: 'Loose card', teamId: TEAM } }), r.res)
      expect((r.body() as TaskBody).task.attention).toEqual({
        reason: 'unassigned',
        failedRuns: 0,
      })
      expect(dispatched).toEqual([])
    })
  })

  describe('GET /api/board', () => {
    it('carries each task’s needs-you state, so the board can route it without a request per card', () => {
      const db = getDb()
      const failed = createTask(db, {
        title: 'failed',
        teamId: TEAM,
        sourceDelegationId: 'r:deleg:agent:coder:reflectTo:lead',
      })
      claimTask(db, failed.id, 'coder')
      const ex = createExecutionProcess(db, { taskId: failed.id, executorType: 'openclaw' })
      completeExecutionProcess(db, ex.id, { status: 'failed', error: 'boom' })
      updateStatus(db, failed.id, 'blocked')
      const fine = createTask(db, {
        title: 'fine',
        teamId: TEAM,
        sourceDelegationId: 'r:deleg:agent:coder:reflectTo:lead',
      })

      const r = mockRes()
      boardListGET(req({ query: { teamId: TEAM } }), r.res)
      const tasks = (r.body() as { tasks: Array<{ id: string; attention: unknown }> }).tasks
      // The card can say WHY without fetching the task: the last run's error rides along.
      expect(tasks.find((t) => t.id === failed.id)?.attention).toEqual({
        reason: 'failed',
        failedRuns: 1,
        detail: 'boom',
      })
      expect(tasks.find((t) => t.id === fine.id)?.attention).toBeNull()

      const one = mockRes()
      boardGetGET(req({ params: { taskId: failed.id } }), one.res)
      expect((one.body() as TaskBody).task.attention).toEqual({
        reason: 'failed',
        failedRuns: 1,
        detail: 'boom',
      })
    })
  })

  describe('POST /api/board/:taskId/retry', () => {
    function failedTask(): string {
      const db = getDb()
      const t = createTask(db, {
        title: 'flaky',
        teamId: TEAM,
        sourceDelegationId: 'r:deleg:agent:coder:reflectTo:lead',
      })
      claimTask(db, t.id, 'coder')
      updateStatus(db, t.id, 'blocked')
      return t.id
    }

    it('puts a failed task back to To do, notes it on the trail, and asks for a run', () => {
      const id = failedTask()
      const r = mockRes()
      boardRetryPOST(req({ params: { taskId: id } }), r.res)
      expect(r.statusCode()).toBe(202)
      expect(getTask(getDb(), id)?.status).toBe('todo')
      expect(getComments(getDb(), id).map((c) => [c.authorType, c.body])).toEqual([
        ['user', 'Retry requested.'],
      ])
      expect(dispatched).toEqual([{ teamId: TEAM, taskId: id }])
    })

    it('refuses a task no agent is bound to (it needs assigning, not retrying)', () => {
      const t = createTask(getDb(), { title: 'loose', teamId: TEAM })
      const r = mockRes()
      boardRetryPOST(req({ params: { taskId: t.id } }), r.res)
      expect(r.statusCode()).toBe(409)
      expect(r.body()).toMatchObject({ error: 'unassigned' })
      expect(dispatched).toEqual([])
    })

    it('refuses a task that is running or finished', () => {
      const db = getDb()
      const t = createTask(db, {
        title: 'live',
        teamId: TEAM,
        sourceDelegationId: 'r:deleg:agent:coder:reflectTo:lead',
      })
      claimTask(db, t.id, 'coder')
      const r = mockRes()
      boardRetryPOST(req({ params: { taskId: t.id } }), r.res)
      expect(r.statusCode()).toBe(409)
      expect(r.body()).toMatchObject({ error: 'not_retryable' })
    })

    it('answers 404 for an unknown task', () => {
      const r = mockRes()
      boardRetryPOST(req({ params: { taskId: 'nope' } }), r.res)
      expect(r.statusCode()).toBe(404)
    })
  })

  describe('POST /api/board/:taskId/assign', () => {
    it('binds an unassigned card to a teammate, notes it, and asks for a run', () => {
      const t = createTask(getDb(), { title: 'loose', teamId: TEAM })
      const r = mockRes()
      boardAssignPOST(req({ params: { taskId: t.id }, body: { agentId: 'writer' } }), r.res)
      expect(r.statusCode()).toBe(200)
      const stored = getTask(getDb(), t.id)!
      expect(delegationTargetOf(stored.sourceDelegationId)).toBe('writer')
      expect(isHumanAssignment(stored.sourceDelegationId)).toBe(true)
      expect(getComments(getDb(), t.id).map((c) => c.body)).toEqual(['Assigned to Writer.'])
      expect(dispatched).toEqual([{ teamId: TEAM, taskId: t.id }])
    })

    it('re-routes a failed task to someone else and puts it back to To do', () => {
      const db = getDb()
      const t = createTask(db, {
        title: 'flaky',
        teamId: TEAM,
        sourceDelegationId: 'r:deleg:agent:coder:reflectTo:lead',
      })
      claimTask(db, t.id, 'coder')
      updateStatus(db, t.id, 'blocked')
      const r = mockRes()
      boardAssignPOST(req({ params: { taskId: t.id }, body: { agentId: 'writer' } }), r.res)
      expect(r.statusCode()).toBe(200)
      const stored = getTask(db, t.id)!
      expect(stored.status).toBe('todo')
      expect(delegationTargetOf(stored.sourceDelegationId)).toBe('writer')
    })

    it('refuses while the task is being worked, and refuses an agent from another team', () => {
      const db = getDb()
      const live = createTask(db, {
        title: 'live',
        teamId: TEAM,
        sourceDelegationId: 'r:deleg:agent:coder:reflectTo:lead',
      })
      claimTask(db, live.id, 'coder')
      const running = mockRes()
      boardAssignPOST(
        req({ params: { taskId: live.id }, body: { agentId: 'writer' } }),
        running.res,
      )
      expect(running.statusCode()).toBe(409)
      expect(running.body()).toMatchObject({ error: 'not_assignable' })

      const loose = createTask(db, { title: 'loose', teamId: TEAM })
      const foreign = mockRes()
      boardAssignPOST(
        req({ params: { taskId: loose.id }, body: { agentId: 'outsider' } }),
        foreign.res,
      )
      expect(foreign.statusCode()).toBe(400)
      expect(foreign.body()).toMatchObject({ error: 'agent_not_in_team' })
      expect(dispatched).toEqual([])
    })
  })
})
