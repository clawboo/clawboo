// The person's routes for a pause: who may write them, what they name, and what a
// paused task reads as on the board.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { encodeHumanAssignment, parseWaitingOn } from '@clawboo/board-core'
import {
  addComment,
  agents,
  askQuestion,
  assignTaskToPerson,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getTask,
  listEvents,
  listExecutions,
  listPauses,
  listWaitingTaskWakes,
  LOCAL_PERSON,
  LOCAL_READER,
  markTaskRead,
  placePause,
  taskReadStates,
  taskTreeRootId,
  tasks,
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

// What an engine does when a pause reaches it: its release is not the person's write.
let teamStop: () => Promise<string[]> = async () => []
vi.mock('../../lib/teamChat/teamOrchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/teamChat/teamOrchestrator')>()),
  stopPausedTeamRuns: () => teamStop(),
}))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const { boardCommentPOST, boardGetGET, boardListGET, boardRetryPOST } = await import('../board')
const { boardQuestionAnswerPOST, boardReopenPOST } = await import('../boardPerson')
const { pausesDELETE, pausesGET, pausesPOST } = await import('../pauses')
const { onPauseLifted } = await import('../../lib/pauseBus')
const { registerRunStop } = await import('../../lib/runStops')
const { teamsPATCH } = await import('../teams')

type Captured = { status: number; body: Record<string, unknown> }

function call(
  handler: (req: Request, res: Response) => void | Promise<void>,
  opts: { body?: unknown; params?: Record<string, string>; dashboard?: boolean; query?: object },
): Promise<Captured> {
  return new Promise((resolve) => {
    const out: Captured = { status: 200, body: {} }
    const res = {
      status(code: number) {
        out.status = code
        return res
      },
      json(payload: Record<string, unknown>) {
        out.body = payload
        resolve(out)
        return res
      },
    } as unknown as Response
    const req = {
      body: opts.body ?? {},
      params: opts.params ?? {},
      query: opts.query ?? {},
      headers:
        opts.dashboard === false
          ? {}
          : { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' },
    } as unknown as Request
    void handler(req, res)
  })
}

describe('the pause routes', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawboo: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-pause-routes-'))
    prevHome = process.env['HOME']
    prevClawboo = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = home
    resetDb()
    expect(getDbPath().startsWith(home)).toBe(true)
    dispatched.length = 0
    const now = Date.now()
    getDb()
      .insert(teams)
      .values({ id: 'T', name: 'Team', icon: 'x', color: 'x', createdAt: now, updatedAt: now })
      .run()
    getDb()
      .insert(agents)
      .values({
        id: 'a1',
        name: 'Ada',
        gatewayId: 'a1',
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
    if (prevClawboo === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawboo
    await rm(home, { recursive: true, force: true })
  })

  const task = (title = 'work', parentTaskId?: string) =>
    createTask(getDb(), {
      title,
      teamId: 'T',
      sourceDelegationId: encodeHumanAssignment('a1', title),
      ...(parentTaskId ? { parentTaskId } : {}),
    })

  it('refuses a write that did not come from the dashboard', async () => {
    const placed = await call(pausesPOST, {
      body: { kind: 'agent', id: 'a1' },
      dashboard: false,
    })
    expect(placed.status).toBe(403)
    expect(listPauses(getDb())).toEqual([])
    placePause(getDb(), { kind: 'agent', id: 'a1' })
    const lifted = await call(pausesDELETE, {
      params: { kind: 'agent', id: 'a1' },
      dashboard: false,
    })
    expect(lifted.status).toBe(403)
    expect(listPauses(getDb())).toHaveLength(1)
  })

  it('pauses, says so once in the event log, and lists it with its name', async () => {
    const first = await call(pausesPOST, { body: { kind: 'agent', id: 'a1', reason: ' why ' } })
    expect(first.status).toBe(201)
    expect(first.body).toMatchObject({
      created: true,
      pause: { kind: 'agent', id: 'a1', name: 'Ada', reason: 'why' },
    })
    const again = await call(pausesPOST, { body: { kind: 'agent', id: 'a1', reason: 'other' } })
    expect(again.status).toBe(200)
    expect(again.body).toMatchObject({ created: false, pause: { reason: 'why' } })
    const events = listEvents(getDb(), { kinds: ['pause_placed'] })
    expect(events).toHaveLength(1)
    const read = await call(pausesGET, {})
    expect(read.body['pauses']).toMatchObject([{ kind: 'agent', id: 'a1', name: 'Ada' }])
  })

  it('names a task tree by its root, from any task in it', async () => {
    const root = task('root')
    const child = task('child', root.id)
    const placed = await call(pausesPOST, { body: { kind: 'task', id: child.id } })
    expect(placed.body).toMatchObject({ pause: { kind: 'task_tree', id: root.id, name: 'root' } })
    expect(taskTreeRootId(getDb(), child.id)).toBe(root.id)
    const lifted = await call(pausesDELETE, { params: { kind: 'task', id: child.id } })
    expect(lifted.status).toBe(200)
    expect(listPauses(getDb())).toEqual([])
  })

  it('refuses a bad scope, a bad reason and something that does not exist', async () => {
    expect((await call(pausesPOST, { body: { kind: 'planet', id: 'x' } })).status).toBe(400)
    expect((await call(pausesPOST, { body: { kind: 'agent' } })).status).toBe(400)
    expect(
      (await call(pausesPOST, { body: { kind: 'agent', id: 'a1', reason: 'x'.repeat(201) } }))
        .status,
    ).toBe(400)
    expect((await call(pausesPOST, { body: { kind: 'agent', id: 'ghost' } })).status).toBe(404)
    expect((await call(pausesDELETE, { params: { kind: 'agent', id: 'a1' } })).status).toBe(404)
  })

  it('resuming tells whoever waits, and writes the event', async () => {
    const seen = vi.fn()
    const stop = onPauseLifted(seen)
    await call(pausesPOST, { body: { kind: 'agent', id: 'a1' } })
    expect((await call(pausesDELETE, { params: { kind: 'agent', id: 'a1' } })).status).toBe(200)
    await Promise.resolve()
    stop()
    expect(seen).toHaveBeenCalledTimes(1)
    expect(listEvents(getDb(), { kinds: ['pause_lifted'] })).toHaveLength(1)
  })

  it('stops the runs it covers while answering at once, by agent and by team', async () => {
    const stopped: string[] = []
    const mine = registerRunStop(task('mine').id, () => stopped.push('mine'), 'a1')
    const queued = registerRunStop(task('queued').id, () => stopped.push('queued'), 'a1', {
      waiting: true,
    })
    const theirs = registerRunStop('elsewhere', () => stopped.push('theirs'), 'a2')
    await call(pausesPOST, { body: { kind: 'agent', id: 'a1' } })
    await vi.waitFor(() => expect(stopped).toEqual(['mine']))
    expect(mine.byPause).toBe(true)
    expect(mine.note).toContain('This agent is paused'.toLowerCase())
    expect(theirs.note).toBeNull()
    expect(queued.note).toBeNull()
    mine.release()
    theirs.release()
    queued.release()
  })

  it("a team pause stops a run on the team's task whoever runs it, and no other team's", async () => {
    const stopped: string[] = []
    // Boo Zero, say: an agent on no team, working a team's task.
    const visiting = registerRunStop(task('visiting').id, () => stopped.push('visiting'), 'boo')
    const elsewhere = registerRunStop('other-team-task', () => stopped.push('elsewhere'), 'boo')
    await call(pausesPOST, { body: { kind: 'team', id: 'T' } })
    await vi.waitFor(() => expect(stopped).toEqual(['visiting']))
    visiting.release()
    elsewhere.release()
  })

  it('stops the runs of a whole tree, whichever task in it they work on', async () => {
    const root = task('root')
    const child = task('child', root.id)
    const stopped: string[] = []
    const handle = registerRunStop(child.id, () => stopped.push('child'), 'a1')
    await call(pausesPOST, { body: { kind: 'task', id: root.id } })
    await vi.waitFor(() => expect(stopped).toEqual(['child']))
    handle.release()
  })

  it('archiving a team stops its runs, and bringing it back lets work start', async () => {
    const t = task()
    const stopped: string[] = []
    const handle = registerRunStop(t.id, () => stopped.push(t.id), 'a1')
    const seen = vi.fn()
    const stop = onPauseLifted(seen)
    await call(teamsPATCH, { params: { id: 'T' }, body: { isArchived: 1 } })
    await vi.waitFor(() => expect(stopped).toEqual([t.id]))
    expect(seen).not.toHaveBeenCalled()
    await call(teamsPATCH, { params: { id: 'T' }, body: { isArchived: 0 } })
    await Promise.resolve()
    expect(seen).toHaveBeenCalledTimes(1)
    // Nothing changed about it: no resume to announce.
    await call(teamsPATCH, { params: { id: 'T' }, body: { isArchived: 0 } })
    await Promise.resolve()
    expect(seen).toHaveBeenCalledTimes(1)
    stop()
    handle.release()
  })

  it('does not list a pause whose agent is gone', async () => {
    placePause(getDb(), { kind: 'agent', id: 'ghost' })
    const read = await call(pausesGET, {})
    expect(read.body['pauses']).toEqual([])
    // And it is gone, so an agent made later under that id does not start out paused.
    expect(listPauses(getDb())).toEqual([])
  })

  it('shows on a board row and on the drawer who or what paused the task', async () => {
    const t = task()
    const before = await call(boardListGET, {})
    expect((before.body['tasks'] as Array<{ pause: unknown }>)[0]!.pause).toBeNull()
    await call(pausesPOST, { body: { kind: 'team', id: 'T' } })
    const after = await call(boardListGET, {})
    expect((after.body['tasks'] as Array<{ pause: unknown }>)[0]!.pause).toMatchObject({
      kind: 'team',
      id: 'T',
      name: 'Team',
    })
    const drawer = await call(boardGetGET, { params: { taskId: t.id } })
    expect((drawer.body['task'] as { pause: unknown }).pause).toMatchObject({ kind: 'team' })

    // A finished task has nothing a pause can hold back, so it does not read as paused.
    getDb().update(tasks).set({ status: 'done' }).where(eq(tasks.id, t.id)).run()
    const done = await call(boardListGET, {})
    expect((done.body['tasks'] as Array<{ pause: unknown }>)[0]!.pause).toBeNull()
  })

  describe('and a person acting on a paused task', () => {
    const LOGO = 'Use the new logo'

    it('an answer is saved, its receipt says the resume, and the card says so too', async () => {
      const t = task()
      claimTask(getDb(), t.id, 'a1', 'openclaw', { run: { executorType: 'openclaw' } })
      const asked = askQuestion(getDb(), {
        taskId: t.id,
        agentId: 'a1',
        kind: 'confirm',
        payload: { prompt: 'Deploy?' },
      })
      if (!asked.ok) throw new Error(asked.reason)
      completeExecutionProcess(getDb(), listExecutions(getDb(), t.id).at(-1)!.id, {
        status: 'succeeded',
      })
      placePause(getDb(), { kind: 'agent', id: 'a1' })

      const res = await call(boardQuestionAnswerPOST, {
        params: { questionId: asked.question.id },
        body: { answer: { confirmed: true } },
      })

      expect(res.status).toBe(200)
      expect(res.body['delivery']).toEqual({ status: 'queued', agentId: 'a1', reason: 'paused' })
      expect(listWaitingTaskWakes(getDb(), { taskId: t.id })).toHaveLength(1)
      expect(dispatched).toEqual([])
      const row = getTask(getDb(), t.id)!
      expect(row.status).toBe('blocked')
      expect(parseWaitingOn(row.waitingOn)).toMatchObject({
        kind: 'person',
        need: 'Your answer is saved on this task. Its agent gets it after the resume.',
      })
    })

    it('a Reopen moves the card, saves its wake, and its receipt says the resume', async () => {
      const t = task()
      updateStatus(getDb(), t.id, 'cancelled', { actor: 'person' })
      placePause(getDb(), { kind: 'agent', id: 'a1' })

      const res = await call(boardReopenPOST, {
        params: { taskId: t.id },
        body: { comment: LOGO },
      })

      expect(res.status).toBe(200)
      expect(res.body['delivery']).toEqual({ status: 'queued', agentId: 'a1', reason: 'paused' })
      expect(getTask(getDb(), t.id)?.status).toBe('todo')
      expect(listWaitingTaskWakes(getDb(), { taskId: t.id })).toHaveLength(1)
      expect(dispatched).toEqual([])
    })

    it('a person’s task does not read as paused, and an agent’s claim hears it is theirs', async () => {
      const t = task()
      expect(assignTaskToPerson(getDb(), t.id, LOCAL_PERSON).ok).toBe(true)
      placePause(getDb(), { kind: 'team', id: 'T' })
      const board = await call(boardListGET, {})
      expect((board.body['tasks'] as Array<{ pause: unknown }>)[0]!.pause).toBeNull()
      expect(claimTask(getDb(), t.id, 'a1')).toMatchObject({ ok: false, reason: 'person_assigned' })
    })
  })

  describe('and what it reads as to the person who did it', () => {
    /** A task its agent is running, which the person has read. */
    const runningRead = () => {
      const t = task()
      updateStatus(getDb(), t.id, 'in_progress')
      const seq = taskReadStates(getDb(), LOCAL_READER).get(t.id)!.activity!.seq
      markTaskRead(getDb(), LOCAL_READER, t.id, seq)
      expect(taskReadStates(getDb(), LOCAL_READER).get(t.id)?.unread).toBe(false)
      return t
    }
    const unread = (id: string) => taskReadStates(getDb(), LOCAL_READER).get(id)?.unread
    afterEach(() => {
      teamStop = async () => []
    })

    it('a task the engine put back in To do for it is not news to them', async () => {
      const t = runningRead()
      let released = false
      teamStop = async () => {
        updateStatus(getDb(), t.id, 'todo')
        released = true
        return [t.id]
      }
      await call(pausesPOST, { body: { kind: 'agent', id: 'a1' } })
      await vi.waitFor(() => expect(released).toBe(true))
      await vi.waitFor(() => expect(unread(t.id)).toBe(false))
      expect(getTask(getDb(), t.id)?.status).toBe('todo')
    })

    it('nor is one the task runner gives back once its abort reaches it', async () => {
      const t = runningRead()
      const stop = registerRunStop(t.id, () => undefined, 'a1')
      let teamsDone = false
      teamStop = async () => {
        teamsDone = true
        return []
      }
      await call(pausesPOST, { body: { kind: 'agent', id: 'a1' } })
      await vi.waitFor(() => expect(stop.byPause && teamsDone).toBe(true))
      // Everything else the pause does is over before this run writes its ending.
      for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))

      updateStatus(getDb(), t.id, 'todo')
      stop.release()
      await vi.waitFor(() => expect(unread(t.id)).toBe(false))
    })

    it('what an agent wrote since stays news', async () => {
      const t = runningRead()
      teamStop = async () => {
        updateStatus(getDb(), t.id, 'todo')
        addComment(getDb(), t.id, 'I had finished, by the way', 'agent', 'a1')
        return [t.id]
      }
      await call(pausesPOST, { body: { kind: 'agent', id: 'a1' } })
      await vi.waitFor(() => expect(getTask(getDb(), t.id)?.status).toBe('todo'))
      await new Promise((r) => setImmediate(r))
      expect(unread(t.id)).toBe(true)
    })

    it('a resume writes nothing to a task, so it brings none back', async () => {
      const t = runningRead()
      placePause(getDb(), { kind: 'agent', id: 'a1' })
      await call(pausesDELETE, { params: { kind: 'agent', id: 'a1' } })
      expect(unread(t.id)).toBe(false)
    })

    it('a request nothing says a person sent marks nothing read', async () => {
      const t = runningRead()
      teamStop = async () => {
        updateStatus(getDb(), t.id, 'todo')
        return [t.id]
      }
      const { pauseRuns } = await import('../../lib/pauseRuns')
      pauseRuns(getDb(), { kind: 'agent', id: 'a1', reader: null })
      await vi.waitFor(() => expect(getTask(getDb(), t.id)?.status).toBe('todo'))
      await new Promise((r) => setImmediate(r))
      expect(unread(t.id)).toBe(true)
    })
  })

  it('refuses a Retry on a paused task, writing nothing and starting nothing', async () => {
    const t = task()
    placePause(getDb(), { kind: 'agent', id: 'a1' })
    const res = await call(boardRetryPOST, { params: { taskId: t.id } })
    expect(res.status).toBe(409)
    expect(res.body).toMatchObject({ ok: false, error: 'paused' })
    expect(dispatched).toEqual([])
  })

  it('keeps a reply on a paused task for its next run, and wakes nothing', async () => {
    const t = task()
    placePause(getDb(), { kind: 'agent', id: 'a1' })
    const res = await call(boardCommentPOST, {
      params: { taskId: t.id },
      body: { body: 'one more thing', authorType: 'user' },
    })
    expect(res.body).toMatchObject({ delivery: { status: 'queued', reason: 'paused' } })
    expect(dispatched).toEqual([])
  })

  it('saves a reply on a blocked task as a wake: it starts on resume, and the card stays', async () => {
    const t = task()
    getDb().update(tasks).set({ status: 'blocked' }).where(eq(tasks.id, t.id)).run()
    placePause(getDb(), { kind: 'agent', id: 'a1' })
    const res = await call(boardCommentPOST, {
      params: { taskId: t.id },
      body: { body: 'try it this way', authorType: 'user' },
    })
    expect(res.body).toMatchObject({ delivery: { status: 'queued', reason: 'paused' } })
    expect(getTask(getDb(), t.id)?.status).toBe('blocked')
    expect(dispatched).toEqual([])
    expect(listWaitingTaskWakes(getDb(), { taskId: t.id })).toHaveLength(1)
  })

  it('does the same for a To do task a person stopped, which the pump would not fire', async () => {
    const t = task()
    const exec = createExecutionProcess(getDb(), { taskId: t.id, executorType: 'openclaw' })
    completeExecutionProcess(getDb(), exec.id, { status: 'cancelled' })
    placePause(getDb(), { kind: 'agent', id: 'a1' })
    const res = await call(boardCommentPOST, {
      params: { taskId: t.id },
      body: { body: 'try it this way', authorType: 'user' },
    })
    expect(res.body).toMatchObject({ delivery: { reason: 'paused' } })
    expect(listWaitingTaskWakes(getDb(), { taskId: t.id })).toHaveLength(1)
  })
})
