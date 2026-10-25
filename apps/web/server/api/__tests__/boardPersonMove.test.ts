// A PERSON moving a card through PATCH /api/board/:taskId, and the routes that
// read or recover what that leaves behind. The route is the person's word on the
// task: it records the finish day they gave, cancels the plan steps a cancel
// strands, says what happened in the team room, and hands the rest to
// `noteHumanMove`: the resident team engine when there is one (recorded here by
// a stub, since the engine's own behaviour is covered in @clawboo/team-orchestration),
// else a durable mailbox notice for whoever delegated the task.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { encodeHumanAssignment } from '@clawboo/board-core'
import {
  agents,
  claimTask,
  createExecutionProcess,
  createTask,
  getComments,
  getTask,
  linkDep,
  listUndeliveredInbox,
  readRoom,
  resolveRoomForTeam,
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

/** What the route asked a resident engine to do, and whether one is resident. */
const engineCalls: Array<{ taskId: string; to: string; opts: unknown }> = []
let resident = false
vi.mock('../../lib/teamChat/teamOrchestrator', () => {
  const orchestrator = () => ({
    personMovedTask: async (taskId: string, to: string, opts: unknown) => {
      engineCalls.push({ taskId, to, opts })
    },
  })
  return {
    getTeamOrchestrator: orchestrator,
    // A person's move reaches the engine of the task's chat room.
    getTaskOrchestrator: orchestrator,
    hasTeamOrchestrator: () => resident,
    hasTaskOrchestrator: () => resident,
  }
})

const { getDb, resetDb } = await import('../../lib/db')
const { boardGetGET, boardRetryPOST, boardUpdatePATCH } = await import('../board')

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

function patch(taskId: string, body: Record<string, unknown>) {
  const r = mockRes()
  boardUpdatePATCH(req({ params: { taskId }, body }), r.res)
  return r
}

const TEAM = 'T'
const DELEGATED = 'r1:deleg:agent:coder:reflectTo:lead'

/** A delegated task the coder is working on. */
function workedTask(title = 'Write the launch post', sourceDelegationId: string = DELEGATED) {
  const db = getDb()
  const t = createTask(db, { title, teamId: TEAM, sourceDelegationId })
  claimTask(db, t.id, 'coder')
  return getTask(db, t.id)!
}

describe('board: a person moving a card', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-person-move-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    dispatched.length = 0
    engineCalls.length = 0
    resident = false
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: TEAM,
        name: 'Team T',
        icon: '🚀',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    for (const id of ['coder', 'lead'])
      db.insert(agents)
        .values({ id, name: id, gatewayId: id, teamId: TEAM, createdAt: now, updatedAt: now })
        .run()
  })

  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory that
    // still holds an open file.
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  describe('the finish day', () => {
    it('records the finish time the person gave', () => {
      const t = workedTask()
      const r = patch(t.id, { status: 'done', completedAt: t.createdAt })
      expect(r.statusCode()).toBe(200)
      expect(getTask(getDb(), t.id)).toMatchObject({ status: 'done', completedAt: t.createdAt })
    })

    it('answers 400 for a finish before the task existed, and moves nothing', () => {
      const t = workedTask()
      const r = patch(t.id, { status: 'cancelled', completedAt: t.createdAt - 1 })
      expect(r.statusCode()).toBe(400)
      expect(r.body()).toEqual({ ok: false, error: 'invalid_completed_at' })
      expect(getTask(getDb(), t.id)?.status).toBe('in_progress')
      expect(readRoom(getDb(), { roomId: resolveRoomForTeam(TEAM) })).toEqual([])
      expect(engineCalls).toEqual([])
    })

    it('answers 400 for a finish far in the future', () => {
      const t = workedTask()
      const r = patch(t.id, { status: 'done', completedAt: Date.now() + 60 * 60_000 })
      expect(r.statusCode()).toBe(400)
      expect(r.body()).toEqual({ ok: false, error: 'invalid_completed_at' })
    })

    it('refuses a finish time on a move that does not finish the task', () => {
      const t = workedTask()
      const r = patch(t.id, { status: 'blocked', completedAt: t.createdAt })
      expect(r.statusCode()).toBe(400)
      expect(getTask(getDb(), t.id)?.status).toBe('in_progress')
    })
  })

  describe('a cancel', () => {
    it('cancels the plan steps waiting on it and returns them', () => {
      const db = getDb()
      const first = workedTask('Step one')
      const second = createTask(db, { title: 'Step two', teamId: TEAM })
      const third = createTask(db, { title: 'Step three', teamId: TEAM })
      const unrelated = createTask(db, { title: 'Unrelated', teamId: TEAM })
      linkDep(db, second.id, first.id)
      linkDep(db, third.id, second.id)

      const r = patch(first.id, { status: 'cancelled' })
      expect(r.statusCode()).toBe(200)
      const body = r.body() as { cancelledDependents: Array<{ id: string; title: string }> }
      expect(body.cancelledDependents).toHaveLength(2)
      expect(body.cancelledDependents).toEqual(
        expect.arrayContaining([
          { id: second.id, title: 'Step two' },
          { id: third.id, title: 'Step three' },
        ]),
      )
      expect(getTask(db, second.id)?.status).toBe('cancelled')
      expect(getTask(db, third.id)?.status).toBe('cancelled')
      expect(getTask(db, unrelated.id)?.status).toBe('todo')
    })

    it('leaves a step that already ran alone', () => {
      const db = getDb()
      const first = workedTask('Step one')
      const second = createTask(db, { title: 'Step two', teamId: TEAM })
      linkDep(db, second.id, first.id)
      claimTask(db, second.id, 'lead')

      const r = patch(first.id, { status: 'cancelled' })
      expect((r.body() as { cancelledDependents: unknown[] }).cancelledDependents).toEqual([])
      expect(getTask(db, second.id)?.status).toBe('in_progress')
    })

    it('a move to done says nothing about dependents', () => {
      const t = workedTask()
      const r = patch(t.id, { status: 'done' })
      expect(r.body()).not.toHaveProperty('cancelledDependents')
    })
  })

  it('says in the team room that a person moved it, with the column it went to', () => {
    const t = workedTask('Write the launch post')
    patch(t.id, { status: 'done' })
    const posts = readRoom(getDb(), { roomId: resolveRoomForTeam(TEAM) })
    expect(posts.map((p) => [p.kind, p.authorAgentId, p.body])).toEqual([
      ['system', 'clawboo', 'A person moved "Write the launch post" to Done.'],
    ])
  })

  describe('with no team engine running', () => {
    it('leaves the delegator a mailbox notice that a person finished it', () => {
      const t = workedTask('Write the launch post')
      patch(t.id, { status: 'done' })
      const mail = listUndeliveredInbox(getDb(), 'lead', { teamId: TEAM })
      expect(mail).toHaveLength(1)
      expect(mail[0]).toMatchObject({
        kind: 'task_update',
        taskId: t.id,
        body: 'A person marked “Write the launch post” done on the board.',
      })
      expect(listUndeliveredInbox(getDb(), 'coder', { teamId: TEAM })).toEqual([])
    })

    it('a cancel tells the delegator not to redo it, and counts the steps cancelled with it', () => {
      const db = getDb()
      const first = workedTask('Step one')
      const second = createTask(db, { title: 'Step two', teamId: TEAM })
      linkDep(db, second.id, first.id)
      patch(first.id, { status: 'cancelled' })
      const [row] = listUndeliveredInbox(db, 'lead', { teamId: TEAM })
      expect(row!.body).toBe(
        'A person cancelled “Step one” on the board. Do not redo it or hand it to anyone again. One later step waiting on it was cancelled too.',
      )
    })

    it('a task a person assigned leaves no notice for anyone', () => {
      const t = workedTask('Mine', encodeHumanAssignment('coder', 'n1'))
      patch(t.id, { status: 'done' })
      expect(listUndeliveredInbox(getDb(), 'lead', { teamId: TEAM })).toEqual([])
      expect(listUndeliveredInbox(getDb(), 'coder', { teamId: TEAM })).toEqual([])
    })

    it('a move that is not a finish leaves no notice, and neither does a repeat', () => {
      const db = getDb()
      const parked = workedTask('Parked')
      patch(parked.id, { status: 'blocked' })
      expect(listUndeliveredInbox(db, 'lead', { teamId: TEAM })).toEqual([])

      const done = workedTask('Done twice')
      patch(done.id, { status: 'done' })
      patch(done.id, { status: 'done' })
      expect(listUndeliveredInbox(db, 'lead', { teamId: TEAM })).toHaveLength(1)
    })
  })

  describe('with the team engine running', () => {
    it('hands the move to the engine, with the steps cancelled alongside it', () => {
      resident = true
      const db = getDb()
      const first = workedTask('Step one')
      const second = createTask(db, { title: 'Step two', teamId: TEAM })
      linkDep(db, second.id, first.id)

      patch(first.id, { status: 'cancelled' })
      expect(engineCalls).toEqual([
        {
          taskId: first.id,
          to: 'cancelled',
          opts: { cancelledDependents: [{ id: second.id, title: 'Step two' }] },
        },
      ])
      // The engine tells the delegator; the mailbox is the no-engine fallback.
      expect(listUndeliveredInbox(db, 'lead', { teamId: TEAM })).toEqual([])
    })

    it('a move back to To do goes to the engine too', () => {
      resident = true
      const t = workedTask()
      patch(t.id, { status: 'todo' })
      expect(engineCalls).toEqual([{ taskId: t.id, to: 'todo', opts: { cancelledDependents: [] } }])
    })

    it('a card dragged into In progress starts nothing and stops nothing', () => {
      resident = true
      const t = createTask(getDb(), {
        title: 'Dragged',
        teamId: TEAM,
        sourceDelegationId: DELEGATED,
      })
      patch(t.id, { status: 'in_progress' })
      expect(engineCalls).toEqual([])
      expect(dispatched).toEqual([])
    })
  })

  describe('a card left in progress with nothing running it', () => {
    function stranded(): string {
      const db = getDb()
      const t = createTask(db, { title: 'Stranded', teamId: TEAM, sourceDelegationId: DELEGATED })
      updateStatus(db, t.id, 'in_progress', { actor: 'person' })
      return t.id
    }

    it('can be retried: back to To do and straight to its agent', () => {
      const id = stranded()
      const r = mockRes()
      boardRetryPOST(req({ params: { taskId: id } }), r.res)
      expect(r.statusCode()).toBe(202)
      expect(getTask(getDb(), id)?.status).toBe('todo')
      expect(getComments(getDb(), id).map((c) => c.body)).toEqual(['Retry requested.'])
      expect(dispatched).toEqual([{ teamId: TEAM, taskId: id }])
    })

    it('cannot be retried while a run is going on it', () => {
      const id = stranded()
      createExecutionProcess(getDb(), { taskId: id, executorType: 'codex' })
      const r = mockRes()
      boardRetryPOST(req({ params: { taskId: id } }), r.res)
      expect(r.statusCode()).toBe(409)
      expect(r.body()).toMatchObject({ error: 'not_retryable' })
      expect(dispatched).toEqual([])
    })
  })

  describe('GET /api/board/:taskId', () => {
    it('says when the running run started, and null when none is running', () => {
      const db = getDb()
      const live = workedTask('Live')
      const exec = createExecutionProcess(db, { taskId: live.id, executorType: 'claude-code' })
      const idle = createTask(db, { title: 'Idle', teamId: TEAM })

      const one = mockRes()
      boardGetGET(req({ params: { taskId: live.id } }), one.res)
      expect((one.body() as { task: { runningSince: number | null } }).task.runningSince).toBe(
        exec.startedAt,
      )
      const two = mockRes()
      boardGetGET(req({ params: { taskId: idle.id } }), two.res)
      expect((two.body() as { task: { runningSince: number | null } }).task.runningSince).toBeNull()
    })
  })
})
