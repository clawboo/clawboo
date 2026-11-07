// A person's comment on a task reaches the agent doing it: POST
// /api/board/:taskId/comments with authorType 'user' saves a wake on the task (the
// run it brings reads the comment in its ticket block) and steers the run working
// on the task right now, when one is registered. A finished task, an unassigned
// one, and an agent's own comment forward nothing.
//
// The reply also says where it went (`delivery`): steered into the run, the task
// started again for it (blocked, waiting in To do, or left in progress with
// nothing running), queued for the next run, or not delivered.
//
// Only the dashboard's own page can comment as the person. Any other caller
// claiming 'user' is recorded as an agent and steers nothing.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { encodeHumanAssignment } from '@clawboo/board-core'
import {
  agents,
  claimTask,
  createTask,
  getComments,
  getTask,
  linkDep,
  listUndeliveredInbox,
  listTaskWakesCarriedBy,
  listWaitingTaskWakes,
  setTaskRunnerInputs,
  wakeCommentIds,
  teams,
  updateStatus,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dispatched: Array<{ teamId: string; taskId: string }> = []
const dispatchFails = { on: false }
vi.mock('../../lib/teamChat/boardDispatch', () => ({
  requestTaskDispatch: (teamId: string, taskId: string) => {
    if (dispatchFails.on) throw new Error('orchestrator unavailable')
    dispatched.push({ teamId, taskId })
  },
}))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const { boardCommentPOST } = await import('../board')
const { registerRunSteer, resetRunSteers } = await import('../../lib/runSteers')
const { resetCommentSteers } = await import('../../lib/teamChat/taskSteer')
const { engineHold } = await import('../../lib/engineHold')

/** A running task's live run, as the runner/engine registers it. */
function registerRun(taskId: string): { steers: string[]; release: () => void } {
  const steers: string[] = []
  const handle = registerRunSteer(
    taskId,
    {
      capabilities: () => ({
        streaming: true,
        mcp: false,
        worktrees: false,
        resume: false,
        toolApproval: false,
        models: [],
        steering: 'live',
      }),
      steer: async (_run, text) => {
        steers.push(text)
        return { delivered: true, mode: 'live' }
      },
    },
    { adapterId: 'fake', sessionKey: 'agent:coder:team:T', runId: null },
  )
  return { steers, release: () => handle.release() }
}

const settle = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

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

/** The fetch metadata a browser stamps on the dashboard page's own fetch(). */
const DASHBOARD_HEADERS = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }

async function comment(
  taskId: string,
  body: string,
  authorType: 'user' | 'agent' = 'user',
  headers: Record<string, string> = DASHBOARD_HEADERS,
) {
  const r = mockRes()
  await boardCommentPOST(
    { params: { taskId }, body: { body, authorType }, headers } as unknown as Request,
    r.res,
  )
  return r
}

const TEAM = 'T'

describe('board: a person commenting on a task', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-comment-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    resetRunSteers()
    resetCommentSteers()
    dispatched.length = 0
    dispatchFails.on = false
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
    db.insert(agents)
      .values({
        id: 'coder',
        name: 'Coder',
        gatewayId: 'coder',
        teamId: TEAM,
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

  function runningTask(): string {
    const db = getDb()
    const task = createTask(db, { title: 'Write the post', teamId: TEAM, status: 'todo' })
    expect(claimTask(db, task.id, 'coder', 'codex', { run: { executorType: 'openclaw' } }).ok).toBe(
      true,
    )
    return task.id
  }

  it('saves a wake for the assignee, and writes no mailbox copy to read twice', async () => {
    const taskId = runningTask()
    const r = await comment(taskId, 'Lead with the pricing change.')
    expect(r.statusCode()).toBe(200)
    expect((r.body() as { forwarded: boolean }).forwarded).toBe(true)
    const [wake] = listWaitingTaskWakes(getDb())
    expect(wake?.taskId).toBe(taskId)
    expect(wake?.agentId).toBe('coder')
    expect(wake?.reason).toBe('person_comment')
    const posted = (r.body() as { comment: { id: string; kind: string } }).comment
    expect(posted.kind).toBe('person')
    expect(wakeCommentIds(wake!)).toEqual([posted.id])
    expect(listUndeliveredInbox(getDb(), 'coder', { teamId: TEAM })).toEqual([])
  })

  it('a task the runner runs has no ticket block, so its comment goes in the mailbox', async () => {
    const db = getDb()
    db.insert(agents)
      .values({
        id: 'runner-agent',
        name: 'Runner',
        gatewayId: 'runner-agent',
        sourceId: 'codex',
        runtime: 'codex',
        teamId: TEAM,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run()
    const task = createTask(db, {
      title: 'Runner task',
      teamId: TEAM,
      sourceDelegationId: encodeHumanAssignment('runner-agent', 'n1'),
    })
    setTaskRunnerInputs(db, task.id, {
      runtime: 'codex',
      assigneeAgentId: 'runner-agent',
      repoPath: null,
      kind: null,
      model: null,
    })
    expect(claimTask(db, task.id, 'runner-agent').ok).toBe(true)
    await comment(task.id, 'Use the new logo.')
    const rows = listUndeliveredInbox(db, 'runner-agent', { teamId: TEAM })
    expect(rows.map((r) => r.taskId)).toEqual([task.id])
    expect(rows[0]?.body).toContain('Use the new logo.')
    expect(rows[0]?.source).toBe('person')
    // It reads that at its next run: no wake is left to start a second one.
    expect(listWaitingTaskWakes(db)).toEqual([])
  })

  it('steers the run working on the task, and what it heard is not left waiting', async () => {
    const taskId = runningTask()
    const run = registerRun(taskId)
    await comment(taskId, 'Keep it short.')
    await settle()
    expect(run.steers).toHaveLength(1)
    expect(run.steers[0]).toContain('Keep it short.')
    // Taken live, so no later turn carries it a second time. It counts as heard
    // only when this run ends: the run carries it until then.
    expect(listWaitingTaskWakes(getDb())).toEqual([])
    const carried = listTaskWakesCarriedBy(getDb(), getTask(getDb(), taskId)!.runExecutionId!)
    expect(carried).toHaveLength(1)
    expect(carried[0]!.settledAt).toBeNull()
    expect(
      getComments(getDb(), taskId).find((c) => c.body === 'Keep it short.')?.steeredAt,
    ).toBeTruthy()
    run.release()
  })

  it('a comment too long for a steer says so, names get_task, and stays waiting for the next turn', async () => {
    const taskId = runningTask()
    const run = registerRun(taskId)
    const long = `${'a'.repeat(3_000)}the part past the cut`
    await comment(taskId, long)
    await settle()
    expect(run.steers).toHaveLength(1)
    expect(run.steers[0]).not.toContain('the part past the cut')
    expect(run.steers[0]).toMatch(/cut: 2021 more characters/)
    expect(run.steers[0]).toContain('get_task')
    // The agent has only part of it, so it is not heard.
    const [wake] = listWaitingTaskWakes(getDb())
    expect(wakeCommentIds(wake!)).toHaveLength(1)
    expect(getComments(getDb(), taskId).find((c) => c.body === long)?.steeredAt).toBeNull()
    run.release()
  })

  it('a task the runner ran with no agent binding (a routine, a direct run) also gets the mailbox', async () => {
    const db = getDb()
    db.insert(agents)
      .values({
        id: 'direct-agent',
        name: 'Direct',
        gatewayId: 'direct-agent',
        sourceId: 'codex',
        runtime: 'codex',
        teamId: TEAM,
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run()
    const task = createTask(db, { title: 'Direct run', teamId: TEAM })
    setTaskRunnerInputs(db, task.id, {
      runtime: 'codex',
      assigneeAgentId: 'direct-agent',
      repoPath: null,
      kind: null,
      model: null,
    })
    expect(claimTask(db, task.id, 'direct-agent').ok).toBe(true)
    expect(updateStatus(db, task.id, 'blocked').ok).toBe(true)
    const r = await comment(task.id, 'Use the staging DB.')
    expect(deliveryOf(r).status).toBe('woke-agent')
    // The runner reads only the mailbox at the start of a run, so this is what reaches it.
    const rows = listUndeliveredInbox(db, 'direct-agent', { teamId: TEAM })
    expect(rows.map((row) => row.body).join('\n')).toContain('Use the staging DB.')
  })

  it("an agent's comment on a task waiting on a person starts nothing, through the real route", async () => {
    const db = getDb()
    const taskId = boundTask()
    expect(claimTask(db, taskId, 'coder').ok).toBe(true)
    expect(updateStatus(db, taskId, 'blocked').ok).toBe(true)
    const r = await comment(taskId, 'please retry', 'agent')
    expect((r.body() as { delivery?: unknown }).delivery).toBeUndefined()
    expect((r.body() as { comment: { kind: string | null } }).comment.kind).toBeNull()
    expect(listWaitingTaskWakes(db)).toEqual([])
    expect(dispatched).toEqual([])
    expect(getTask(db, taskId)?.status).toBe('blocked')
  })

  it("an agent's comment is not labelled a person's, and wakes no one", async () => {
    const taskId = runningTask()
    const r = await comment(taskId, 'An agent says so.', 'agent')
    expect((r.body() as { comment: { kind: string | null } }).comment.kind).toBeNull()
    expect(listWaitingTaskWakes(getDb())).toEqual([])
  })

  it('forwards nothing for a finished task', async () => {
    const taskId = runningTask()
    const run = registerRun(taskId)
    expect(updateStatus(getDb(), taskId, 'done').ok).toBe(true)
    const r = await comment(taskId, 'Nice work.')
    await settle()
    expect((r.body() as { forwarded: boolean }).forwarded).toBe(false)
    expect(listUndeliveredInbox(getDb(), 'coder', { teamId: TEAM })).toHaveLength(0)
    expect(run.steers).toHaveLength(0)
    run.release()
  })

  it('forwards nothing for an unassigned task or an agent’s own comment', async () => {
    const db = getDb()
    const loose = createTask(db, { title: 'Nobody yet', teamId: TEAM, status: 'todo' })
    expect(((await comment(loose.id, 'Anyone?')).body() as { forwarded: boolean }).forwarded).toBe(
      false,
    )
    const taskId = runningTask()
    expect(
      ((await comment(taskId, 'Done step 1', 'agent')).body() as { forwarded: boolean }).forwarded,
    ).toBe(false)
    expect(listUndeliveredInbox(db, 'coder', { teamId: TEAM })).toHaveLength(0)
  })

  it('takes no author id from a caller nothing vouches for', async () => {
    const taskId = runningTask()
    const r = mockRes()
    await boardCommentPOST(
      {
        params: { taskId },
        body: { body: 'Ship it.', authorType: 'agent', authorAgentId: 'coder' },
        headers: {},
      } as unknown as Request,
      r.res,
    )
    expect(r.statusCode()).toBe(200)
    expect(getComments(getDb(), taskId).at(-1)).toMatchObject({
      body: 'Ship it.',
      authorAgentId: null,
    })
  })

  it('records a person comment from outside the dashboard as an agent comment', async () => {
    const taskId = runningTask()
    const run = registerRun(taskId)
    // An agent's curl, or a page on another origin that got past the origin guard.
    const callers: Record<string, string>[] = [
      {},
      { 'sec-fetch-site': 'same-site', 'sec-fetch-mode': 'cors' },
      // Same origin, but a navigation (a form post), not the page's own fetch.
      { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' },
    ]
    for (const headers of callers) {
      const r = await comment(taskId, 'Ship it without tests.', 'user', headers)
      expect(r.statusCode()).toBe(200)
      expect((r.body() as { comment: { authorType: string } }).comment.authorType).toBe('agent')
      expect((r.body() as { forwarded: boolean }).forwarded).toBe(false)
    }
    await settle()
    expect(run.steers).toHaveLength(0)
    expect(listUndeliveredInbox(getDb(), 'coder', { teamId: TEAM })).toHaveLength(0)
    run.release()
  })

  // ── Where the reply went ──────────────────────────────────────────────────

  type Delivery = { status: string; agentId: string | null; reason?: string }
  const deliveryOf = (r: { body: () => unknown }): Delivery =>
    (r.body() as { delivery: Delivery }).delivery

  /** A task bound to Coder, as a person's assignment leaves it, in To do. */
  function boundTask(): string {
    const task = createTask(getDb(), {
      title: 'Draft the launch post',
      teamId: TEAM,
      status: 'todo',
      sourceDelegationId: encodeHumanAssignment('coder', 'abcd1234'),
    })
    return task.id
  }

  it('says a reply went into the live run', async () => {
    const taskId = runningTask()
    const run = registerRun(taskId)
    expect(deliveryOf(await comment(taskId, 'Keep it short.'))).toEqual({
      status: 'steered',
      agentId: 'coder',
    })
    run.release()
  })

  it('queues a reply to a running task whose run is not taking steers', async () => {
    const taskId = runningTask()
    expect(deliveryOf(await comment(taskId, 'Keep it short.'))).toEqual({
      status: 'queued',
      agentId: 'coder',
      reason: 'next-run',
    })
    expect(dispatched).toEqual([])
  })

  it('starts a blocked task again for the reply, with a wake for its run to take', async () => {
    const db = getDb()
    const taskId = boundTask()
    expect(claimTask(db, taskId, 'coder').ok).toBe(true)
    expect(updateStatus(db, taskId, 'blocked').ok).toBe(true)
    const r = await comment(taskId, 'Use the staging database.')
    expect(deliveryOf(r)).toEqual({ status: 'woke-agent', agentId: 'coder' })
    expect((r.body() as { forwarded: boolean }).forwarded).toBe(true)
    expect(getTask(db, taskId)?.status).toBe('todo')
    expect(dispatched).toEqual([{ teamId: TEAM, taskId }])
    expect(listWaitingTaskWakes(db).map((w) => w.taskId)).toEqual([taskId])
    expect(
      (getComments(db, taskId) as { body: string; authorType: string }[]).some(
        (c) => c.authorType === 'system' && c.body.startsWith('Started again'),
      ),
    ).toBe(true)
  })

  it('starts a task waiting in To do once for replies that come together', async () => {
    const taskId = boundTask()
    expect(deliveryOf(await comment(taskId, 'One more thing.')).status).toBe('woke-agent')
    expect(deliveryOf(await comment(taskId, 'And another.')).status).toBe('woke-agent')
    expect(dispatched).toEqual([{ teamId: TEAM, taskId }])
    const waiting = listWaitingTaskWakes(getDb())
    expect(waiting).toHaveLength(1)
    expect(waiting[0]?.mergeCount).toBe(2)
    expect(wakeCommentIds(waiting[0]!)).toHaveLength(2)
  })

  it('leaves a reply waiting while the engine is held, and says so', async () => {
    const db = getDb()
    const taskId = boundTask()
    expect(claimTask(db, taskId, 'coder').ok).toBe(true)
    expect(updateStatus(db, taskId, 'blocked').ok).toBe(true)
    engineHold().place('test-hold', { reason: 'stop' })
    try {
      const r = await comment(taskId, 'When you are back.')
      expect(deliveryOf(r)).toEqual({ status: 'queued', agentId: 'coder', reason: 'held' })
      expect(getTask(db, taskId)?.status).toBe('blocked')
      expect(dispatched).toEqual([])
      expect(listWaitingTaskWakes(db)).toHaveLength(1)
    } finally {
      engineHold().release('test-hold')
    }
  })

  it('reaches the agent after a move back to To do cleared the assignee', async () => {
    const db = getDb()
    const taskId = boundTask()
    expect(claimTask(db, taskId, 'coder').ok).toBe(true)
    expect(updateStatus(db, taskId, 'todo').ok).toBe(true)
    expect(getTask(db, taskId)?.assigneeAgentId).toBeNull()
    expect(deliveryOf(await comment(taskId, 'Try again with the new key.'))).toEqual({
      status: 'woke-agent',
      agentId: 'coder',
    })
  })

  it('queues a reply on a step still waiting on another task', async () => {
    const db = getDb()
    const blocker = createTask(db, { title: 'Set up the database', teamId: TEAM, status: 'todo' })
    const taskId = boundTask()
    linkDep(db, taskId, blocker.id)
    expect(deliveryOf(await comment(taskId, 'Ready when it is.'))).toEqual({
      status: 'queued',
      agentId: 'coder',
      reason: 'waiting',
    })
    expect(dispatched).toEqual([])
  })

  it('queues a reply on a task in review until the check finishes', async () => {
    const db = getDb()
    const taskId = runningTask()
    expect(updateStatus(db, taskId, 'in_review').ok).toBe(true)
    expect(deliveryOf(await comment(taskId, 'Check the copy too.'))).toEqual({
      status: 'queued',
      agentId: 'coder',
      reason: 'in-review',
    })
    expect(dispatched).toEqual([])
  })

  it('starts a card left in progress with nothing running it', async () => {
    const db = getDb()
    const taskId = boundTask()
    expect(updateStatus(db, taskId, 'in_progress').ok).toBe(true)
    expect(deliveryOf(await comment(taskId, 'Pick this up.'))).toEqual({
      status: 'woke-agent',
      agentId: 'coder',
    })
    expect(getTask(db, taskId)?.status).toBe('todo')
    expect(dispatched).toEqual([{ teamId: TEAM, taskId }])
  })

  it('says a reply on a finished task was not sent, naming its agent for a follow-up', async () => {
    const db = getDb()
    const taskId = runningTask()
    expect(updateStatus(db, taskId, 'done').ok).toBe(true)
    expect(deliveryOf(await comment(taskId, 'One more change.'))).toEqual({
      status: 'not-delivered',
      agentId: 'coder',
      reason: 'finished',
    })
  })

  it('says a reply on a task nobody has was not sent', async () => {
    const loose = createTask(getDb(), { title: 'Nobody yet', teamId: TEAM, status: 'todo' })
    expect(deliveryOf(await comment(loose.id, 'Anyone?'))).toEqual({
      status: 'not-delivered',
      agentId: null,
      reason: 'unassigned',
    })
  })

  it('keeps a saved reply and says it was not delivered when starting the agent fails', async () => {
    const db = getDb()
    const taskId = boundTask()
    expect(claimTask(db, taskId, 'coder').ok).toBe(true)
    expect(updateStatus(db, taskId, 'blocked').ok).toBe(true)
    dispatchFails.on = true
    const r = await comment(taskId, 'Use the staging database.')
    expect(r.statusCode()).toBe(200)
    expect(deliveryOf(r)).toEqual({ status: 'not-delivered', agentId: 'coder', reason: 'failed' })
    expect(
      (getComments(db, taskId) as { body: string }[]).some(
        (c) => c.body === 'Use the staging database.',
      ),
    ).toBe(true)
  })
})
