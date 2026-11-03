// A person handing work straight to one agent: POST /api/board with an assignee,
// POST /api/board/:id/retry and POST /api/board/:id/assign. The dispatch itself
// (the team orchestrator claiming and delivering) is covered by the cascade
// contract; here it is replaced by a recorder so each route's DECISION is what is
// asserted: what it binds, what it moves, and whether it asks for a run at all.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { delegationTargetOf, encodeHumanAssignment, isHumanAssignment } from '@clawboo/board-core'
import {
  agents,
  archiveRoom,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createRoom,
  createTask,
  getComments,
  getTask,
  setTaskRunnerInputs,
  teams,
  updateStatus,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dispatched: Array<{ teamId: string; taskId: string }> = []
vi.mock('../../lib/teamChat/boardDispatch', () => ({
  requestTaskDispatch: (teamId: string, taskId: string) => {
    dispatched.push({ teamId, taskId })
  },
}))
// The rerun DECISION (runnerRerunFor) stays real; the run itself is recorded.
const reruns: Array<{ taskId: string; assigneeAgentId: string; runtime: string }> = []
vi.mock('../../lib/runnerRerun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/runnerRerun')>()),
  requestRunnerRerun: (
    _db: unknown,
    input: { taskId: string; assigneeAgentId: string; rerun: { runtime: string } },
  ) => {
    reruns.push({
      taskId: input.taskId,
      assigneeAgentId: input.assigneeAgentId,
      runtime: input.rerun.runtime,
    })
  },
}))

const { getDb, resetDb } = await import('../../lib/db')
const {
  boardAssignPOST,
  boardCommentPOST,
  boardCreatePOST,
  boardGetGET,
  boardListGET,
  boardRetryPOST,
} = await import('../board')

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
    reruns.length = 0
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
    const agent = (
      id: string,
      name: string,
      teamId: string,
      archivedAt: number | null = null,
      runtime = 'openclaw',
    ) =>
      db
        .insert(agents)
        .values({
          id,
          name,
          gatewayId: id,
          teamId,
          archivedAt,
          runtime,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    agent('coder', 'Coder', TEAM)
    agent('builder', 'Builder', TEAM, null, 'claude-code')
    agent('reviewer', 'Reviewer', TEAM, null, 'codex')
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

    describe('a task the task runner ran', () => {
      /** Failed on the runner for `builder`, then set aside as a Routine does. */
      function runnerTask(teamId: string | null = TEAM): string {
        const db = getDb()
        const t = createTask(db, { title: 'fix it', teamId })
        setTaskRunnerInputs(db, t.id, {
          runtime: 'claude-code',
          assigneeAgentId: 'builder',
          repoPath: '/repo',
          kind: 'code',
          model: null,
        })
        claimTask(db, t.id, 'builder')
        updateStatus(db, t.id, 'blocked')
        return t.id
      }

      it('runs it through the runner again for the agent it ran for, not team chat', () => {
        const id = runnerTask()
        const r = mockRes()
        boardRetryPOST(req({ params: { taskId: id } }), r.res)
        expect(r.statusCode()).toBe(202)
        expect(getTask(getDb(), id)?.status).toBe('todo')
        expect(reruns).toEqual([{ taskId: id, assigneeAgentId: 'builder', runtime: 'claude-code' }])
        expect(dispatched).toEqual([])
      })

      it('needs no team, because the runner does not go through one', () => {
        const id = runnerTask(null)
        const r = mockRes()
        boardRetryPOST(req({ params: { taskId: id } }), r.res)
        expect(r.statusCode()).toBe(202)
        expect(reruns.map((x) => x.taskId)).toEqual([id])
      })

      it('asks for an Assign when the agent it ran for is gone and none is bound', () => {
        // Team chat fires a task by its binding, so with no runner rerun and no
        // binding there is nothing to start: answering 202 would start nothing.
        const db = getDb()
        for (const saved of ['gone', 'deleted-agent']) {
          const t = createTask(db, { title: `ran for ${saved}`, teamId: TEAM })
          setTaskRunnerInputs(db, t.id, {
            runtime: 'claude-code',
            assigneeAgentId: saved,
            repoPath: null,
            kind: null,
            model: null,
          })
          updateStatus(db, t.id, 'blocked')
          const r = mockRes()
          boardRetryPOST(req({ params: { taskId: t.id } }), r.res)
          expect(r.statusCode(), saved).toBe(409)
          expect(r.body(), saved).toMatchObject({ error: 'unassigned' })
        }
        expect(reruns).toEqual([])
        expect(dispatched).toEqual([])
      })

      it('a person’s reply restarts it through the runner too', async () => {
        const db = getDb()
        const t = createTask(db, {
          title: 'reply to me',
          teamId: TEAM,
          sourceDelegationId: encodeHumanAssignment('builder', 'r1'),
        })
        setTaskRunnerInputs(db, t.id, {
          runtime: 'claude-code',
          assigneeAgentId: 'builder',
          repoPath: '/repo',
          kind: 'code',
          model: null,
        })
        updateStatus(db, t.id, 'blocked')
        const r = mockRes()
        await boardCommentPOST(
          req({
            params: { taskId: t.id },
            body: { body: 'try the other branch', authorType: 'user' },
          }),
          r.res,
        )
        expect(reruns).toEqual([
          { taskId: t.id, assigneeAgentId: 'builder', runtime: 'claude-code' },
        ])
        expect(dispatched).toEqual([])
      })
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

    it('runs a task-runner task through the runner, on the new agent’s runtime', () => {
      const db = getDb()
      const t = createTask(db, { title: 'fix it', teamId: TEAM })
      setTaskRunnerInputs(db, t.id, {
        runtime: 'claude-code',
        assigneeAgentId: 'builder',
        repoPath: '/repo',
        kind: 'code',
        model: null,
      })
      const r = mockRes()
      boardAssignPOST(req({ params: { taskId: t.id }, body: { agentId: 'reviewer' } }), r.res)
      expect(r.statusCode()).toBe(200)
      expect(reruns).toEqual([{ taskId: t.id, assigneeAgentId: 'reviewer', runtime: 'codex' }])
      expect(dispatched).toEqual([])
    })

    it('hands a task-runner task to team chat when the new agent is one the runner cannot run', () => {
      const db = getDb()
      const t = createTask(db, { title: 'fix it', teamId: TEAM })
      setTaskRunnerInputs(db, t.id, {
        runtime: 'claude-code',
        assigneeAgentId: 'builder',
        repoPath: null,
        kind: null,
        model: null,
      })
      const r = mockRes()
      boardAssignPOST(req({ params: { taskId: t.id }, body: { agentId: 'writer' } }), r.res)
      expect(r.statusCode()).toBe(200)
      expect(reruns).toEqual([])
      expect(dispatched).toEqual([{ teamId: TEAM, taskId: t.id }])
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

  // K2. A task still filed under an archived chat room is outside every engine:
  // the team's own chat reads only tasks with no room, and the archived room has
  // no engine at all. Retry answered 202, Assign 200 and a reply "Started again"
  // while nothing ever ran. Archiving now moves such tasks to the team's own
  // chat, so this is the guard for one the move missed: refuse before writing.
  describe('a task still filed under an archived chat room', () => {
    function archivedRoomTask(): string {
      const db = getDb()
      const roomId = createRoom(db, { teamId: TEAM, name: 'Design', memberIds: ['coder'] }).id
      const t = createTask(db, {
        title: 'stuck',
        teamId: TEAM,
        roomId,
        sourceDelegationId: 'r:deleg:agent:coder:reflectTo:lead',
      })
      claimTask(db, t.id, 'coder')
      updateStatus(db, t.id, 'blocked')
      archiveRoom(db, roomId)
      return t.id
    }

    it('Retry refuses it before writing anything', () => {
      const id = archivedRoomTask()
      const r = mockRes()
      boardRetryPOST(req({ params: { taskId: id } }), r.res)
      expect(r.statusCode()).toBe(409)
      expect(r.body()).toMatchObject({ ok: false, error: 'room_archived' })
      expect(getTask(getDb(), id)?.status).toBe('blocked')
      expect(getComments(getDb(), id)).toEqual([])
      expect(dispatched).toEqual([])
    })

    it('Assign refuses it before writing anything', () => {
      const id = archivedRoomTask()
      const before = getTask(getDb(), id)?.sourceDelegationId
      const r = mockRes()
      boardAssignPOST(req({ params: { taskId: id }, body: { agentId: 'writer' } }), r.res)
      expect(r.statusCode()).toBe(409)
      expect(r.body()).toMatchObject({ ok: false, error: 'room_archived' })
      expect(getTask(getDb(), id)?.sourceDelegationId).toBe(before)
      expect(getTask(getDb(), id)?.status).toBe('blocked')
      expect(getComments(getDb(), id)).toEqual([])
      expect(dispatched).toEqual([])
    })

    it('a reply says it was not sent instead of "Started again"', async () => {
      const id = archivedRoomTask()
      const r = mockRes()
      await boardCommentPOST(
        req({ params: { taskId: id }, body: { body: 'try again please', authorType: 'user' } }),
        r.res,
      )
      expect(r.body()).toMatchObject({
        forwarded: false,
        delivery: { status: 'not-delivered', agentId: 'coder', reason: 'room_archived' },
      })
      expect(getTask(getDb(), id)?.status).toBe('blocked')
      expect(getComments(getDb(), id).map((c) => c.body)).toEqual(['try again please'])
      expect(dispatched).toEqual([])
    })

    it('a task the task runner ran still reruns, since the runner uses no chat room', () => {
      const db = getDb()
      const roomId = createRoom(db, { teamId: TEAM, name: 'Ops', memberIds: ['builder'] }).id
      const t = createTask(db, { title: 'fix it', teamId: TEAM, roomId })
      setTaskRunnerInputs(db, t.id, {
        runtime: 'claude-code',
        assigneeAgentId: 'builder',
        repoPath: '/repo',
        kind: 'code',
        model: null,
      })
      updateStatus(db, t.id, 'blocked')
      archiveRoom(db, roomId)
      const r = mockRes()
      boardRetryPOST(req({ params: { taskId: t.id } }), r.res)
      expect(r.statusCode()).toBe(202)
      expect(reruns).toEqual([{ taskId: t.id, assigneeAgentId: 'builder', runtime: 'claude-code' }])
    })
  })

  // A room is deleted only with its team, so a task still filed under a room
  // that is gone has no chat left at all: restarting moves it nowhere.
  describe('a task whose chat room went with its team', () => {
    function deletedTeamTask(): string {
      const db = getDb()
      const roomId = createRoom(db, { teamId: OTHER_TEAM, name: 'Ops', memberIds: ['outsider'] }).id
      const t = createTask(db, {
        title: 'orphaned',
        teamId: OTHER_TEAM,
        roomId,
        sourceDelegationId: 'r:deleg:agent:outsider:reflectTo:lead',
      })
      claimTask(db, t.id, 'outsider')
      updateStatus(db, t.id, 'blocked')
      // As the team delete route does: orphan its agents, then drop the team,
      // which takes its rooms with it.
      db.update(agents).set({ teamId: null }).where(eq(agents.teamId, OTHER_TEAM)).run()
      db.delete(teams).where(eq(teams.id, OTHER_TEAM)).run()
      return t.id
    }

    it('Retry refuses it as having no team, not as an archived room', () => {
      const id = deletedTeamTask()
      const r = mockRes()
      boardRetryPOST(req({ params: { taskId: id } }), r.res)
      expect(r.statusCode()).toBe(409)
      expect(r.body()).toMatchObject({ ok: false, error: 'no_team' })
      expect(dispatched).toEqual([])
    })

    it('a reply says the team is gone', async () => {
      const id = deletedTeamTask()
      const r = mockRes()
      await boardCommentPOST(
        req({ params: { taskId: id }, body: { body: 'still need this', authorType: 'user' } }),
        r.res,
      )
      expect(r.body()).toMatchObject({
        forwarded: false,
        delivery: { status: 'not-delivered', reason: 'no_team' },
      })
      expect(dispatched).toEqual([])
    })
  })

  it('a reply reruns a task the runner ran through the runner, as Retry does', async () => {
    // The task has no hand-off marker, only what the runner was given. The reply
    // used to read the marker alone and hand the task to team chat instead.
    const db = getDb()
    const t = createTask(db, { title: 'fix the build', teamId: TEAM })
    setTaskRunnerInputs(db, t.id, {
      runtime: 'claude-code',
      assigneeAgentId: 'builder',
      repoPath: '/repo',
      kind: 'code',
      model: null,
    })
    claimTask(db, t.id, 'builder')
    updateStatus(db, t.id, 'blocked')
    const r = mockRes()
    await boardCommentPOST(
      req({ params: { taskId: t.id }, body: { body: 'try again', authorType: 'user' } }),
      r.res,
    )
    expect(r.body()).toMatchObject({ delivery: { status: 'woke-agent', agentId: 'builder' } })
    expect(reruns).toEqual([{ taskId: t.id, assigneeAgentId: 'builder', runtime: 'claude-code' }])
    expect(dispatched).toEqual([])
  })
})
