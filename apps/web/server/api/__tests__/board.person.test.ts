// A person's own writes on the board: Reopen, assign to a person, answer a question.
// Each takes the person check. The run itself is replaced by a recorder, so what is
// asserted is each route's decision: what it writes and whether it asks for a run.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { encodeHumanAssignment, parseWaitingOn } from '@clawboo/board-core'
import {
  addComment,
  agents,
  archiveRoom,
  askQuestion,
  assignTaskToPerson,
  attentionForTask,
  claimTask,
  createExecutionProcess,
  createRoom,
  createTask,
  getComments,
  getTask,
  handBackTask,
  linkDep,
  listEvents,
  listTaskQuestions,
  listUndeliveredInbox,
  listWaitingTaskWakes,
  noteTaskWakeSkip,
  LOCAL_READER,
  openAgentWakeCard,
  readAgentWakeGate,
  readTeamAlwaysAllow,
  saveAgentCommentWake,
  setTaskRunnerInputs,
  taskReadStates,
  teams,
  updateStatus,
  wakeCommentIds,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dispatched: Array<{ teamId: string; taskId: string }> = []
vi.mock('../../lib/teamChat/boardDispatch', () => ({
  requestTaskDispatch: (teamId: string, taskId: string) => {
    dispatched.push({ teamId, taskId })
  },
}))

// The rerun DECISION (runnerRerunFor) stays real; the run itself is recorded.
const reruns: string[] = []
vi.mock('../../lib/runnerRerun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/runnerRerun')>()),
  requestRunnerRerun: (_db: unknown, input: { taskId: string }) => {
    reruns.push(input.taskId)
  },
}))

const wakeFails = { value: false }
vi.mock('../../lib/teamChat/personWake', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../lib/teamChat/personWake')>()
  return {
    ...real,
    startPersonWake: (...args: Parameters<typeof real.startPersonWake>) => {
      if (wakeFails.value) throw new Error('boom')
      return real.startPersonWake(...args)
    },
  }
})

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const { engineHold } = await import('../../lib/engineHold')
const {
  boardClaimPOST,
  boardCommentPOST,
  boardCreatePOST,
  boardGetGET,
  boardListGET,
  boardRetryPOST,
} = await import('../board')
const {
  boardAgentWakesPOST,
  boardAssignPersonPOST,
  boardQuestionAnswerPOST,
  boardQuestionsGET,
  boardReopenPOST,
} = await import('../boardPerson')
const { teamAgentWakesGET, teamAgentWakesPUT } = await import('../teamAgentWakes')

/** What the routes answer, as far as these tests read it. */
interface RouteBody {
  ok?: boolean
  error?: string
  delivery: { status: string; reason?: string }
  task: { assigneePersonId: string | null; requestedBy: string; openQuestion: { id: string } }
  tasks: Array<{
    id: string
    openQuestion: { id: string }
    waitingOn: string | null
    attention: { reason: string }
  }>
  questions: unknown[]
}

function mockRes(): { res: Response; statusCode: () => number; body: () => RouteBody } {
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
  return { res, statusCode: () => code, body: () => payload as RouteBody }
}
const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const req = (over: Partial<Request> & { person?: unknown } = {}): Request =>
  ({
    params: {},
    query: {},
    body: {},
    headers: {},
    app: { locals: {} },
    socket: { localPort: 3000 },
    ...over,
  }) as unknown as Request

const TEAM = 'T'
const BOUND = encodeHumanAssignment('a1', 'n1')
const PRIYA = { id: 'p-priya', name: 'Priya', role: 'admin' }

describe('a person’s writes on the board', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-person-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    dispatched.length = 0
    reruns.length = 0
    const db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: TEAM, name: 'Team', icon: 'i', color: 'c', createdAt: now, updatedAt: now })
      .run()
    db.insert(agents)
      .values({
        id: 'a1',
        runtime: 'hermes',
        name: 'Ada',
        teamId: TEAM,
        gatewayId: 'gw',
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
    await rm(home, { recursive: true, force: true })
  })

  function finished(end: 'done' | 'cancelled', sdid: string | null = BOUND): string {
    const db = getDb()
    const t = createTask(db, {
      title: 'Build it',
      teamId: TEAM,
      status: 'todo',
      ...(sdid ? { sourceDelegationId: sdid } : {}),
    })
    if (sdid) claimTask(db, t.id, 'a1')
    updateStatus(db, t.id, end, { actor: 'person', ...(end === 'done' && !sdid ? {} : {}) })
    return t.id
  }

  function asked(kind: 'question' | 'confirm' = 'question'): {
    taskId: string
    questionId: string
  } {
    const db = getDb()
    const t = createTask(db, {
      title: 'Ask',
      teamId: TEAM,
      status: 'todo',
      sourceDelegationId: BOUND,
    })
    claimTask(db, t.id, 'a1')
    const r = askQuestion(db, {
      taskId: t.id,
      agentId: 'a1',
      kind,
      payload: {
        prompt: 'Which colour?',
        ...(kind === 'question' ? { options: ['Red', 'Blue'] } : {}),
      },
    })
    if (!r.ok) throw new Error('ask failed')
    return { taskId: t.id, questionId: r.question.id }
  }

  describe('POST /api/board/:taskId/reopen', () => {
    it('works only for a request the dashboard’s page sent', async () => {
      const id = finished('done')
      const m = mockRes()
      await boardReopenPOST(req({ params: { taskId: id } }), m.res)
      expect(m.statusCode()).toBe(403)
      expect(getTask(getDb(), id)?.status).toBe('done')
    })

    it('moves it to To do, clears the finish time, and starts its agent', async () => {
      for (const end of ['done', 'cancelled'] as const) {
        const id = finished(end)
        const m = mockRes()
        await boardReopenPOST(req({ params: { taskId: id }, headers: DASHBOARD }), m.res)
        expect(m.statusCode(), end).toBe(200)
        const row = getTask(getDb(), id)
        expect(row?.status).toBe('todo')
        expect(row?.completedAt).toBeNull()
        expect(dispatched.map((d) => d.taskId)).toContain(id)
      }
    })

    it('carries the person’s comment, and records who it was', async () => {
      const id = finished('done')
      const m = mockRes()
      await boardReopenPOST(
        req({
          params: { taskId: id },
          headers: DASHBOARD,
          body: { comment: 'The logo is wrong' },
          person: PRIYA,
        }),
        m.res,
      )
      expect(m.statusCode()).toBe(200)
      const comment = getComments(getDb(), id).find((c) => c.body === 'The logo is wrong')
      expect(comment?.authorType).toBe('user')
      expect(JSON.parse(comment?.person ?? '{}')).toEqual(PRIYA)
      expect(m.body().delivery.status).toBe('woke-agent')
      expect(dispatched.map((d) => d.taskId)).toContain(id)
    })

    it('records the built-in person on a local install', async () => {
      const id = finished('done')
      await boardReopenPOST(req({ params: { taskId: id }, headers: DASHBOARD }), mockRes().res)
      const note = getComments(getDb(), id).at(-1)
      expect(JSON.parse(note?.person ?? '{}')).toEqual({ id: 'local', name: 'You', role: null })
    })

    it('a person’s task goes back to them and starts nothing', async () => {
      const db = getDb()
      const t = createTask(db, { title: 'Mine', teamId: TEAM, status: 'todo' })
      assignTaskToPerson(db, t.id, { id: 'local', name: 'You', role: null })
      updateStatus(db, t.id, 'done', { actor: 'person' })
      await boardReopenPOST(req({ params: { taskId: t.id }, headers: DASHBOARD }), mockRes().res)
      expect(getTask(db, t.id)?.status).toBe('todo')
      expect(dispatched).toHaveLength(0)
    })

    it('saves a wake for the note, naming its comment, and starts from it', async () => {
      const db = getDb()
      const t = createTask(db, {
        title: 'Filed away',
        teamId: TEAM,
        status: 'todo',
        sourceDelegationId: BOUND,
      })
      updateStatus(db, t.id, 'cancelled', { actor: 'person' })
      const m = mockRes()
      await boardReopenPOST(
        req({ params: { taskId: t.id }, headers: DASHBOARD, body: { comment: 'Go again' } }),
        m.res,
      )
      expect(m.body().delivery).toMatchObject({ status: 'woke-agent' })
      const [row] = listWaitingTaskWakes(db, { taskId: t.id })
      expect(row?.reason).toBe('reopened')
      const note = getComments(db, t.id).find((c) => c.body === 'Go again')
      expect(note?.kind).toBe('person')
      expect(wakeCommentIds(row!)).toEqual([note?.id])
      expect(dispatched.map((d) => d.taskId)).toContain(t.id)
    })

    it('clears the slot a person’s cancel freed, and does not read as news to them', async () => {
      const db = getDb()
      const parent = createTask(db, { title: 'Parent', teamId: TEAM, status: 'todo' })
      const child = createTask(db, {
        title: 'Child',
        teamId: TEAM,
        status: 'todo',
        parentTaskId: parent.id,
      })
      updateStatus(db, child.id, 'cancelled', { actor: 'person' })
      await boardReopenPOST(
        req({ params: { taskId: child.id }, headers: DASHBOARD }),
        mockRes().res,
      )
      expect(getTask(db, child.id)?.personCancelledAt).toBeNull()
      expect(taskReadStates(db, LOCAL_READER, { taskId: child.id }).get(child.id)?.unread).toBe(
        false,
      )
    })

    it('refuses a step whose blocker stays cancelled, and says so', async () => {
      const db = getDb()
      const blocker = createTask(db, { title: 'First', teamId: TEAM, status: 'todo' })
      const step = createTask(db, {
        title: 'Second',
        teamId: TEAM,
        status: 'todo',
        sourceDelegationId: BOUND,
      })
      linkDep(db, step.id, blocker.id)
      updateStatus(db, blocker.id, 'cancelled')
      updateStatus(db, step.id, 'cancelled')
      const m = mockRes()
      await boardReopenPOST(req({ params: { taskId: step.id }, headers: DASHBOARD }), m.res)
      expect(m.statusCode()).toBe(409)
      expect(m.body().error).toBe('blocker_cancelled')
      expect(getTask(db, step.id)?.status).toBe('cancelled')
      expect(dispatched).toEqual([])
    })

    it('refuses a task that is not finished, and the board PATCH cannot do it', async () => {
      const db = getDb()
      const t = createTask(db, { title: 'x', teamId: TEAM, status: 'todo' })
      const m = mockRes()
      await boardReopenPOST(req({ params: { taskId: t.id }, headers: DASHBOARD }), m.res)
      expect(m.statusCode()).toBe(409)
    })

    it('says when the note reached no one', async () => {
      const db = getDb()
      const roomId = createRoom(db, { teamId: TEAM, name: 'Design', memberIds: ['a1'] }).id
      const t = createTask(db, {
        title: 'Filed away',
        teamId: TEAM,
        roomId,
        status: 'todo',
        sourceDelegationId: BOUND,
      })
      claimTask(db, t.id, 'a1')
      updateStatus(db, t.id, 'done', { actor: 'person' })
      archiveRoom(db, roomId)
      const m = mockRes()
      await boardReopenPOST(
        req({ params: { taskId: t.id }, headers: DASHBOARD, body: { comment: 'Go again' } }),
        m.res,
      )
      expect(m.statusCode()).toBe(200)
      expect(m.body().delivery).toMatchObject({ status: 'not-delivered', reason: 'room_archived' })
      expect(dispatched).toHaveLength(0)
    })

    it('says when a task with no note could not start', async () => {
      const db = getDb()
      const roomId = createRoom(db, { teamId: TEAM, name: 'Design', memberIds: ['a1'] }).id
      const t = createTask(db, {
        title: 'Filed away',
        teamId: TEAM,
        roomId,
        status: 'todo',
        sourceDelegationId: BOUND,
      })
      claimTask(db, t.id, 'a1')
      updateStatus(db, t.id, 'done', { actor: 'person' })
      archiveRoom(db, roomId)
      const m = mockRes()
      await boardReopenPOST(req({ params: { taskId: t.id }, headers: DASHBOARD }), m.res)
      expect(m.body().delivery).toMatchObject({ status: 'not-delivered', reason: 'room_archived' })
    })

    it('a reply already on the thread reaches a run with no ticket block, and is not doubled', async () => {
      const db = getDb()
      const t = createTask(db, { title: 'Routine post', teamId: TEAM, status: 'todo' })
      setTaskRunnerInputs(db, t.id, {
        runtime: 'hermes',
        assigneeAgentId: 'a1',
        repoPath: null,
        kind: null,
        model: null,
      })
      claimTask(db, t.id, 'a1')
      updateStatus(db, t.id, 'done', { actor: 'person' })
      // The reply: saved, and not delivered, because the task is finished.
      const reply = mockRes()
      await boardCommentPOST(
        req({
          params: { taskId: t.id },
          headers: DASHBOARD,
          body: { body: 'Use the new logo', authorType: 'user' },
        }),
        reply.res,
      )
      expect(reply.body().delivery).toMatchObject({ status: 'not-delivered', reason: 'finished' })
      expect(listUndeliveredInbox(db, 'a1', { teamId: TEAM })).toHaveLength(0)

      // The receipt's Reopen.
      const m = mockRes()
      await boardReopenPOST(
        req({
          params: { taskId: t.id },
          headers: DASHBOARD,
          body: { comment: 'Use the new logo', onThread: true },
        }),
        m.res,
      )
      expect(m.statusCode()).toBe(200)
      expect(reruns).toEqual([t.id])
      const mail = listUndeliveredInbox(db, 'a1', { teamId: TEAM })
      expect(mail.map((r) => r.body).join()).toContain('Use the new logo')
      expect(getComments(db, t.id).filter((c) => c.body === 'Use the new logo')).toHaveLength(1)
    })

    it('after it, a person’s reply reaches the agent again', async () => {
      const id = finished('done')
      const before = mockRes()
      await boardCommentPOST(
        req({
          params: { taskId: id },
          headers: DASHBOARD,
          body: { body: 'hi', authorType: 'user' },
        }),
        before.res,
      )
      expect(before.body().delivery).toMatchObject({ status: 'not-delivered', reason: 'finished' })
      await boardReopenPOST(req({ params: { taskId: id }, headers: DASHBOARD }), mockRes().res)
      const after = mockRes()
      await boardCommentPOST(
        req({
          params: { taskId: id },
          headers: DASHBOARD,
          body: { body: 'hi', authorType: 'user' },
        }),
        after.res,
      )
      expect(after.body().delivery.status).not.toBe('not-delivered')
    })
  })

  describe('POST /api/board/:taskId/assign-person', () => {
    it('works only for a request the dashboard’s page sent', () => {
      const t = createTask(getDb(), { title: 'x', teamId: TEAM, status: 'todo' })
      const m = mockRes()
      boardAssignPersonPOST(req({ params: { taskId: t.id } }), m.res)
      expect(m.statusCode()).toBe(403)
      expect(getTask(getDb(), t.id)?.assigneePersonId).toBeNull()
    })

    it('assigns the sender: the built-in person locally, the verified person behind a proxy', () => {
      const db = getDb()
      const local = createTask(db, { title: 'x', teamId: TEAM, status: 'todo' })
      boardAssignPersonPOST(
        req({ params: { taskId: local.id }, headers: DASHBOARD }),
        mockRes().res,
      )
      expect(getTask(db, local.id)?.assigneePersonId).toBe('local')

      const proxied = createTask(db, { title: 'y', teamId: TEAM, status: 'todo' })
      boardAssignPersonPOST(
        req({ params: { taskId: proxied.id }, headers: DASHBOARD, person: PRIYA }),
        mockRes().res,
      )
      expect(getTask(db, proxied.id)?.assigneePersonId).toBe('p-priya')
    })

    it('never makes a person out of what the body says', () => {
      const t = createTask(getDb(), { title: 'x', teamId: TEAM, status: 'todo' })
      const m = mockRes()
      boardAssignPersonPOST(
        req({ params: { taskId: t.id }, headers: DASHBOARD, body: { personId: 'someone-else' } }),
        m.res,
      )
      expect(m.statusCode()).toBe(400)
      expect(getTask(getDb(), t.id)?.assigneePersonId).toBeNull()
    })

    it('can name the person who asked for the task', () => {
      const t = createTask(getDb(), {
        title: 'x',
        teamId: TEAM,
        status: 'todo',
        requestedBy: PRIYA,
      })
      const m = mockRes()
      boardAssignPersonPOST(
        req({ params: { taskId: t.id }, headers: DASHBOARD, body: { personId: 'p-priya' } }),
        m.res,
      )
      expect(m.statusCode()).toBe(200)
      expect(getTask(getDb(), t.id)?.assigneePersonId).toBe('p-priya')
    })

    it('refuses a task being worked, and takes a person off with null', () => {
      const db = getDb()
      const t = createTask(db, { title: 'x', teamId: TEAM, status: 'todo' })
      claimTask(db, t.id, 'a1')
      const m = mockRes()
      boardAssignPersonPOST(req({ params: { taskId: t.id }, headers: DASHBOARD }), m.res)
      expect(m.statusCode()).toBe(409)

      const mine = createTask(db, { title: 'y', teamId: TEAM, status: 'todo' })
      boardAssignPersonPOST(req({ params: { taskId: mine.id }, headers: DASHBOARD }), mockRes().res)
      boardAssignPersonPOST(
        req({ params: { taskId: mine.id }, headers: DASHBOARD, body: { personId: null } }),
        mockRes().res,
      )
      expect(getTask(db, mine.id)?.assigneePersonId).toBeNull()
    })
  })

  it('taking a task does not read as news to the person who took it', () => {
    const db = getDb()
    const t = createTask(db, { title: 'Mine now', teamId: TEAM, status: 'todo' })
    boardAssignPersonPOST(req({ params: { taskId: t.id }, headers: DASHBOARD }), mockRes().res)
    expect(taskReadStates(db, LOCAL_READER, { taskId: t.id }).get(t.id)?.unread).toBe(false)
  })

  describe('one assignee on the other routes', () => {
    it('a new task cannot name both', () => {
      const m = mockRes()
      boardCreatePOST(
        req({
          headers: DASHBOARD,
          body: { title: 'x', teamId: TEAM, assigneeAgentId: 'a1', assignToMe: true },
        }),
        m.res,
      )
      expect(m.statusCode()).toBe(400)
      expect(m.body()).toEqual({ error: 'one_assignee' })
    })

    it('a new task for me is created assigned, and starts nothing', () => {
      const m = mockRes()
      boardCreatePOST(
        req({ headers: DASHBOARD, body: { title: 'x', teamId: TEAM, assignToMe: true } }),
        m.res,
      )
      expect(m.statusCode()).toBe(200)
      expect(m.body().task.assigneePersonId).toBe('local')
      expect(dispatched).toHaveLength(0)
    })

    it('only the dashboard may assign a new task to the sender', () => {
      const m = mockRes()
      boardCreatePOST(req({ body: { title: 'x', teamId: TEAM, assignToMe: true } }), m.res)
      expect(m.statusCode()).toBe(403)
    })

    it('records who asked for a task the dashboard made, and not for anyone else', () => {
      const a = mockRes()
      boardCreatePOST(req({ headers: DASHBOARD, body: { title: 'x', teamId: TEAM } }), a.res)
      expect(JSON.parse(a.body().task.requestedBy).id).toBe('local')
      const b = mockRes()
      boardCreatePOST(req({ body: { title: 'y', teamId: TEAM } }), b.res)
      expect(b.body().task.requestedBy).toBeNull()
    })

    it('the REST claim refuses a person’s task', () => {
      const db = getDb()
      const t = createTask(db, { title: 'x', teamId: TEAM, status: 'todo' })
      assignTaskToPerson(db, t.id, { id: 'local', name: 'You', role: null })
      const m = mockRes()
      boardClaimPOST(req({ params: { taskId: t.id }, body: { assigneeAgentId: 'a1' } }), m.res)
      expect(m.statusCode()).toBe(409)
      expect(m.body()).toEqual({ ok: false, error: 'person_assigned' })
    })

    it('Retry on a handed-back task gives the turn back to its agent', () => {
      const db = getDb()
      const t = createTask(db, {
        title: 'x',
        teamId: TEAM,
        status: 'todo',
        sourceDelegationId: BOUND,
      })
      claimTask(db, t.id, 'a1')
      handBackTask(db, t.id, { agentId: 'a1', need: 'Look at it' })
      const m = mockRes()
      boardRetryPOST(req({ params: { taskId: t.id }, headers: DASHBOARD }), m.res)
      expect(m.statusCode()).toBe(202)
      expect(getTask(db, t.id)?.assigneePersonId).toBeNull()
      expect(getTask(db, t.id)?.status).toBe('todo')
      expect(dispatched.map((d) => d.taskId)).toContain(t.id)
    })

    it('a reply on a handed-back task wakes its agent; on a person’s own task it reaches no one', async () => {
      const db = getDb()
      const t = createTask(db, {
        title: 'x',
        teamId: TEAM,
        status: 'todo',
        sourceDelegationId: BOUND,
      })
      claimTask(db, t.id, 'a1')
      handBackTask(db, t.id, { agentId: 'a1', need: 'Look at it' })
      const m = mockRes()
      await boardCommentPOST(
        req({
          params: { taskId: t.id },
          headers: DASHBOARD,
          body: { body: 'Done, go on', authorType: 'user' },
        }),
        m.res,
      )
      expect(m.body().delivery.status).toBe('woke-agent')
      expect(getTask(db, t.id)?.assigneePersonId).toBeNull()

      const own = createTask(db, {
        title: 'y',
        teamId: TEAM,
        status: 'todo',
        sourceDelegationId: BOUND,
      })
      assignTaskToPerson(db, own.id, { id: 'local', name: 'You', role: null })
      const n = mockRes()
      await boardCommentPOST(
        req({
          params: { taskId: own.id },
          headers: DASHBOARD,
          body: { body: 'a note', authorType: 'user' },
        }),
        n.res,
      )
      expect(n.body().delivery).toMatchObject({ status: 'not-delivered', reason: 'unassigned' })
      expect(getTask(db, own.id)?.assigneePersonId).toBe('local')
    })
  })

  describe('POST /api/board/agent-wakes/:jobTaskId', () => {
    /** A task with the card up: an agent wants to wake its agent. */
    function asking(): string {
      const db = getDb()
      const t = createTask(db, {
        title: 'Parked',
        teamId: TEAM,
        status: 'todo',
        sourceDelegationId: BOUND,
      })
      claimTask(db, t.id, 'a1')
      updateStatus(db, t.id, 'blocked', {
        waitingOn: { kind: 'person', need: 'A key', by: 'agent' },
      })
      saveAgentCommentWake(
        db,
        t.id,
        addComment(db, t.id, 'Here it is', 'agent', 'a2', { kind: 'agent' }),
      )
      openAgentWakeCard(db, { taskId: t.id, kind: 'ask', fromAgentId: 'a2', toAgentId: 'a1' })
      return t.id
    }
    const press = async (
      jobTaskId: string,
      decision: string,
      headers: Record<string, string> = DASHBOARD,
    ) => {
      const m = mockRes()
      await boardAgentWakesPOST(req({ params: { jobTaskId }, headers, body: { decision } }), m.res)
      return m
    }

    it('works only for a request that passes the person check', async () => {
      const id = asking()
      const m = await press(id, 'job', {})
      expect(m.statusCode()).toBe(403)
      expect(m.body().error).toBe('person_only')
      expect(readAgentWakeGate(getDb(), id)?.decision).toBeNull()
    })

    it('yes on this job: starts the wake that waited, and records who said so', async () => {
      const id = asking()
      const m = await press(id, 'job')
      expect(m.statusCode()).toBe(200)
      const db = getDb()
      expect(readAgentWakeGate(db, id)).toMatchObject({ decision: 'allow', cardKind: null })
      expect(getTask(db, id)?.status).toBe('todo')
      expect(listEvents(db, { kinds: ['status_changed'] }).at(-1)?.data).toContain('wake')
      expect(getComments(db, id).some((c) => c.body.includes('wake each other on this job'))).toBe(
        true,
      )
      expect(taskReadStates(db, LOCAL_READER, { taskId: id }).get(id)?.unread).toBe(false)
    })

    it('a yes starts the other jobs waiting on the same answer too', async () => {
      const id = asking()
      const behind = asking()
      const db = getDb()
      noteTaskWakeSkip(db, listWaitingTaskWakes(db, { taskId: behind })[0]!.id, 'ask_once')
      expect(attentionForTask(db, id)?.agentWakes?.alsoWaiting).toBe(1)
      expect((await press(id, 'job')).statusCode()).toBe(200)
      expect(readAgentWakeGate(db, behind)?.decision).toBe('allow')
      expect(getTask(db, id)?.status).toBe('todo')
      expect(getTask(db, behind)?.status).toBe('todo')
    })

    it('always in this team: sets the team’s setting, for the next job too', async () => {
      const id = asking()
      expect((await press(id, 'team')).statusCode()).toBe(200)
      expect(readTeamAlwaysAllow(getDb(), TEAM)).toBe(true)
    })

    it('no: closes the wake, and the task stays as it was', async () => {
      const id = asking()
      expect((await press(id, 'no')).statusCode()).toBe(200)
      const db = getDb()
      expect(readAgentWakeGate(db, id)?.decision).toBe('deny')
      expect(listWaitingTaskWakes(db, { taskId: id })).toEqual([])
      expect(getTask(db, id)?.status).toBe('blocked')
      expect(attentionForTask(db, id)?.reason).toBe('blocked')
      // Their own answer, with nothing moved after it, is not news to them.
      expect(taskReadStates(db, LOCAL_READER, { taskId: id }).get(id)?.unread).toBe(false)
    })

    it('a second press answers nothing, and a wrong word is refused', async () => {
      const id = asking()
      expect((await press(id, 'maybe')).statusCode()).toBe(400)
      await press(id, 'no')
      const again = await press(id, 'job')
      expect(again.statusCode()).toBe(409)
      expect(again.body().error).toBe('no_card')
      expect(readAgentWakeGate(getDb(), id)?.decision).toBe('deny')
    })
  })

  describe('the team’s setting', () => {
    const put = (body: unknown, headers: Record<string, string> = DASHBOARD) => {
      const m = mockRes()
      teamAgentWakesPUT(req({ params: { teamId: TEAM }, headers, body }), m.res)
      return m
    }

    it('reads off by default, and a person can turn it on and off', () => {
      const read = mockRes()
      teamAgentWakesGET(req({ params: { teamId: TEAM } }), read.res)
      expect(read.body()).toMatchObject({ always: false })
      expect(put({ always: true }).statusCode()).toBe(200)
      expect(readTeamAlwaysAllow(getDb(), TEAM)).toBe(true)
      expect(put({ always: false }).statusCode()).toBe(200)
      expect(readTeamAlwaysAllow(getDb(), TEAM)).toBe(false)
    })

    it('only the dashboard’s page may change it', () => {
      const m = put({ always: true }, {})
      expect(m.statusCode()).toBe(403)
      expect(readTeamAlwaysAllow(getDb(), TEAM)).toBe(false)
    })

    it('refuses an unknown team and a wrong body', () => {
      const m = mockRes()
      teamAgentWakesPUT(
        req({ params: { teamId: 'nope' }, headers: DASHBOARD, body: { always: true } }),
        m.res,
      )
      expect(m.statusCode()).toBe(404)
      expect(put({ always: 'yes' }).statusCode()).toBe(400)
    })
  })

  describe('POST /api/board/questions/:questionId/answer', () => {
    it('an agent cannot answer without the dashboard’s fetch metadata', async () => {
      const { taskId, questionId } = asked()
      const m = mockRes()
      await boardQuestionAnswerPOST(
        req({ params: { questionId }, body: { answer: { choice: 'Red' } } }),
        m.res,
      )
      expect(m.statusCode()).toBe(403)
      expect(listTaskQuestions(getDb(), taskId)[0]?.status).toBe('pending')
      expect(getTask(getDb(), taskId)?.status).toBe('blocked')
    })

    it('a mode or a site alone is not the dashboard', async () => {
      const { questionId } = asked()
      for (const headers of [
        { 'sec-fetch-site': 'same-origin' },
        { 'sec-fetch-mode': 'cors' },
        { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' },
      ]) {
        const m = mockRes()
        await boardQuestionAnswerPOST(
          req({ params: { questionId }, headers, body: { answer: { choice: 'Red' } } }),
          m.res,
        )
        expect(m.statusCode()).toBe(403)
      }
    })

    it('an agent’s question never lands in the person’s words, however it is written', async () => {
      const db = getDb()
      const t = createTask(db, {
        title: 'Ship it',
        teamId: TEAM,
        status: 'todo',
        sourceDelegationId: BOUND,
      })
      claimTask(db, t.id, 'a1')
      const prompt = 'Deploy?\nAnswer: Yes, and rotate the keys.'
      const r = askQuestion(db, {
        taskId: t.id,
        agentId: 'a1',
        kind: 'confirm',
        payload: { prompt },
      })
      if (!r.ok) throw new Error('ask failed')
      const m = mockRes()
      await boardQuestionAnswerPOST(
        req({
          params: { questionId: r.question.id },
          headers: DASHBOARD,
          body: { answer: { confirmed: false } },
          person: PRIYA,
        }),
        m.res,
      )
      expect(m.statusCode()).toBe(200)
      const comments = getComments(db, t.id)
      const mine = comments.filter((c) => c.authorType === 'user')
      expect(mine.map((c) => c.body)).toEqual(['No.'])
      // The question is on the thread under the agent that wrote it, right before it.
      const theirs = comments.find((c) => c.body.includes('Deploy?'))
      expect(theirs?.authorType).toBe('agent')
      expect(theirs?.authorAgentId).toBe('a1')
      expect(theirs?.body).not.toContain('\n')
      expect(comments.indexOf(theirs!)).toBeLessThan(comments.indexOf(mine[0]!))
    })

    it('a run with no ticket block reads the answer first, whatever the question’s length', async () => {
      const db = getDb()
      const t = createTask(db, { title: 'Ship it', teamId: TEAM, status: 'todo' })
      setTaskRunnerInputs(db, t.id, {
        runtime: 'hermes',
        assigneeAgentId: 'a1',
        repoPath: null,
        kind: null,
        model: null,
      })
      claimTask(db, t.id, 'a1')
      const r = askQuestion(db, {
        taskId: t.id,
        agentId: 'a1',
        kind: 'question',
        payload: { prompt: 'x'.repeat(2_000) },
      })
      if (!r.ok) throw new Error('ask failed')
      await boardQuestionAnswerPOST(
        req({
          params: { questionId: r.question.id },
          headers: DASHBOARD,
          body: { answer: { text: 'Blue' } },
        }),
        mockRes().res,
      )
      const mail = listUndeliveredInbox(db, 'a1', { teamId: TEAM })
      expect(mail.map((r) => r.body).join()).toContain('Blue')
    })

    it('records the answer, puts it on the thread in the person’s name, and starts the agent', async () => {
      const { taskId, questionId } = asked()
      const m = mockRes()
      await boardQuestionAnswerPOST(
        req({
          params: { questionId },
          headers: DASHBOARD,
          body: { answer: { choice: 'Blue' } },
          person: PRIYA,
        }),
        m.res,
      )
      expect(m.statusCode()).toBe(200)
      const db = getDb()
      const q = listTaskQuestions(db, taskId)[0]
      expect(q?.status).toBe('answered')
      expect(JSON.parse(q?.answeredBy ?? '{}')).toEqual(PRIYA)
      const comment = getComments(db, taskId).find((c) => c.body.includes('Blue'))
      expect(comment?.authorType).toBe('user')
      expect(comment?.body).toBe('Blue')
      expect(getTask(db, taskId)?.status).toBe('todo')
      expect(getTask(db, taskId)?.waitingOn).toBeNull()
      expect(dispatched.map((d) => d.taskId)).toContain(taskId)
      expect(m.body().delivery.status).toBe('woke-agent')
    })

    it('records the built-in person on a local install', async () => {
      const { taskId, questionId } = asked()
      await boardQuestionAnswerPOST(
        req({ params: { questionId }, headers: DASHBOARD, body: { answer: { choice: 'Blue' } } }),
        mockRes().res,
      )
      expect(JSON.parse(listTaskQuestions(getDb(), taskId)[0]?.answeredBy ?? '{}')).toEqual({
        id: 'local',
        name: 'You',
        role: null,
      })
    })

    it('says why an answer did not land', async () => {
      const { taskId, questionId } = asked()
      const bad = mockRes()
      await boardQuestionAnswerPOST(
        req({ params: { questionId }, headers: DASHBOARD, body: { answer: { choice: 'Green' } } }),
        bad.res,
      )
      expect(bad.statusCode()).toBe(400)

      updateStatus(getDb(), taskId, 'cancelled', { actor: 'person' })
      const late = mockRes()
      await boardQuestionAnswerPOST(
        req({ params: { questionId }, headers: DASHBOARD, body: { answer: { choice: 'Red' } } }),
        late.res,
      )
      expect(late.statusCode()).toBe(409)
      expect(late.body()).toEqual({ ok: false, error: 'expired' })
      expect(dispatched).toHaveLength(0)

      const missing = mockRes()
      await boardQuestionAnswerPOST(
        req({
          params: { questionId: 'nope' },
          headers: DASHBOARD,
          body: { answer: { choice: 'Red' } },
        }),
        missing.res,
      )
      expect(missing.statusCode()).toBe(404)
    })

    it('tells the person, and says so on the card, when the answer reached no one', async () => {
      const db = getDb()
      const roomId = createRoom(db, { teamId: TEAM, name: 'Design', memberIds: ['a1'] }).id
      const t = createTask(db, {
        title: 'Ask',
        teamId: TEAM,
        roomId,
        status: 'todo',
        sourceDelegationId: BOUND,
      })
      claimTask(db, t.id, 'a1')
      const asked = askQuestion(db, {
        taskId: t.id,
        agentId: 'a1',
        kind: 'confirm',
        payload: { prompt: 'Go?' },
      })
      if (!asked.ok) throw new Error('ask failed')
      archiveRoom(db, roomId)
      const m = mockRes()
      await boardQuestionAnswerPOST(
        req({
          params: { questionId: asked.question.id },
          headers: DASHBOARD,
          body: { answer: { confirmed: true } },
        }),
        m.res,
      )
      expect(m.statusCode()).toBe(200)
      expect(m.body().delivery).toMatchObject({ status: 'not-delivered', reason: 'room_archived' })
      expect(listTaskQuestions(db, t.id)[0]?.status).toBe('answered')
      // The card no longer reads as an agent's bare block.
      expect(getTask(db, t.id)?.status).toBe('blocked')
      expect(attentionForTask(db, t.id)?.detail).toMatch(/answer is saved/i)
      expect(dispatched).toHaveLength(0)
    })

    it('a start that failed leaves the wake waiting for the pump, and says the answer is saved', async () => {
      const { taskId, questionId } = asked()
      wakeFails.value = true
      const m = mockRes()
      await boardQuestionAnswerPOST(
        req({ params: { questionId }, headers: DASHBOARD, body: { answer: { choice: 'Blue' } } }),
        m.res,
      )
      wakeFails.value = false
      expect(m.statusCode()).toBe(200)
      expect(m.body().delivery).toMatchObject({ status: 'queued', reason: 'next-run' })
      expect(listWaitingTaskWakes(getDb(), { taskId }).map((w) => w.reason)).toEqual([
        'question_answered',
      ])
      expect(attentionForTask(getDb(), taskId)?.detail).toMatch(/answer is saved/i)
    })

    it('saves the wake with the answer, naming the comment that carries it', async () => {
      const { taskId, questionId } = asked()
      await boardQuestionAnswerPOST(
        req({ params: { questionId }, headers: DASHBOARD, body: { answer: { choice: 'Blue' } } }),
        mockRes().res,
      )
      const db = getDb()
      const [row] = listWaitingTaskWakes(db, { taskId })
      expect(row?.reason).toBe('question_answered')
      const answerComment = getComments(db, taskId).find((c) => c.body === 'Blue')
      expect(answerComment?.kind).toBe('person')
      expect(wakeCommentIds(row!)).toEqual([answerComment?.id])
    })

    it('while Clawboo holds new runs: the card stays, the wake waits, and it says so', async () => {
      const { taskId, questionId } = asked()
      engineHold().place('test-hold', { reason: 'stop' })
      try {
        const m = mockRes()
        await boardQuestionAnswerPOST(
          req({ params: { questionId }, headers: DASHBOARD, body: { answer: { choice: 'Blue' } } }),
          m.res,
        )
        expect(m.body().delivery).toMatchObject({ status: 'queued', reason: 'held' })
        expect(getTask(getDb(), taskId)?.status).toBe('blocked')
        expect(dispatched).toEqual([])
        expect(listWaitingTaskWakes(getDb(), { taskId })).toHaveLength(1)
        expect(attentionForTask(getDb(), taskId)?.detail).toMatch(/answer is saved/i)
        // Their own answer, with nothing else moved after it, is not news to them.
        expect(taskReadStates(getDb(), LOCAL_READER, { taskId }).get(taskId)?.unread).toBe(false)
      } finally {
        engineHold().release('test-hold')
      }
    })

    it('a person’s own answer does not read as news to them', async () => {
      const { taskId, questionId } = asked()
      await boardQuestionAnswerPOST(
        req({ params: { questionId }, headers: DASHBOARD, body: { answer: { choice: 'Blue' } } }),
        mockRes().res,
      )
      expect(taskReadStates(getDb(), LOCAL_READER, { taskId }).get(taskId)?.unread).toBe(false)
    })

    it('a task’s open question rides its board row, and the reads list them all', async () => {
      const { taskId, questionId } = asked()
      const list = mockRes()
      boardListGET(req({ query: { teamId: TEAM } }), list.res)
      const row = list.body().tasks.find((t) => t.id === taskId)
      expect(row?.openQuestion.id).toBe(questionId)
      expect(parseWaitingOn(row?.waitingOn)).toEqual({ kind: 'question', questionId })
      expect(row?.attention.reason).toBe('question')

      const one = mockRes()
      boardGetGET(req({ params: { taskId } }), one.res)
      expect(one.body().task.openQuestion.id).toBe(questionId)

      const all = mockRes()
      boardQuestionsGET(req({ params: { taskId } }), all.res)
      expect(all.body().questions).toHaveLength(1)
    })

    it('an asking run still open leaves a ledger the next start reads', () => {
      const { taskId } = asked()
      createExecutionProcess(getDb(), { taskId, executorType: 'openclaw' })
      expect(getTask(getDb(), taskId)?.status).toBe('blocked')
    })
  })
})
