// A person's comment on a task reaches the agent doing it: POST
// /api/board/:taskId/comments with authorType 'user' puts the comment in the
// assignee's mailbox (read when its next run starts) and steers the run working
// on the task right now, when one is registered. A finished task, an unassigned
// one, and an agent's own comment forward nothing.
//
// The reply also says where it went (`delivery`): steered into the run, the task
// started again for it (blocked, waiting in To do, or left in progress with
// nothing running), queued for the next run, or not delivered.

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
const { boardCommentPOST } = await import('../board')
const { registerRunSteer, resetRunSteers } = await import('../../lib/runSteers')
const { resetReplyWakes } = await import('../../lib/teamChat/personReply')

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

async function comment(taskId: string, body: string, authorType: 'user' | 'agent' = 'user') {
  const r = mockRes()
  await boardCommentPOST(
    { params: { taskId }, body: { body, authorType } } as unknown as Request,
    r.res,
  )
  return r
}

const TEAM = 'T'

describe('board: a person commenting on a task', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-comment-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    resetRunSteers()
    resetReplyWakes()
    dispatched.length = 0
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
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  function runningTask(): string {
    const db = getDb()
    const task = createTask(db, { title: 'Write the post', teamId: TEAM, status: 'todo' })
    expect(claimTask(db, task.id, 'coder').ok).toBe(true)
    return task.id
  }

  it('puts the comment in the assignee’s mailbox', async () => {
    const taskId = runningTask()
    const r = await comment(taskId, 'Lead with the pricing change.')
    expect(r.statusCode()).toBe(200)
    expect((r.body() as { forwarded: boolean }).forwarded).toBe(true)
    const rows = listUndeliveredInbox(getDb(), 'coder', { teamId: TEAM })
    expect(rows).toHaveLength(1)
    expect(rows[0]?.taskId).toBe(taskId)
    expect(rows[0]?.body).toContain('Lead with the pricing change.')
  })

  it('steers the run working on the task, and the mailbox copy is marked delivered', async () => {
    const taskId = runningTask()
    const run = registerRun(taskId)
    await comment(taskId, 'Keep it short.')
    await settle()
    expect(run.steers).toHaveLength(1)
    expect(run.steers[0]).toContain('Keep it short.')
    // Taken live, so the agent will not read it a second time at its next run.
    expect(listUndeliveredInbox(getDb(), 'coder', { teamId: TEAM })).toHaveLength(0)
    run.release()
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

  it('starts a blocked task again for the reply, and the run reads it from the mailbox', async () => {
    const db = getDb()
    const taskId = boundTask()
    expect(claimTask(db, taskId, 'coder').ok).toBe(true)
    expect(updateStatus(db, taskId, 'blocked').ok).toBe(true)
    const r = await comment(taskId, 'Use the staging database.')
    expect(deliveryOf(r)).toEqual({ status: 'woke-agent', agentId: 'coder' })
    expect((r.body() as { forwarded: boolean }).forwarded).toBe(true)
    expect(getTask(db, taskId)?.status).toBe('todo')
    expect(dispatched).toEqual([{ teamId: TEAM, taskId }])
    expect(listUndeliveredInbox(db, 'coder', { teamId: TEAM })[0]?.body).toContain(
      'Use the staging database.',
    )
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
    expect(listUndeliveredInbox(getDb(), 'coder', { teamId: TEAM })).toHaveLength(2)
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
})
