// A person's comment on a task reaches the agent doing it: POST
// /api/board/:taskId/comments with authorType 'user' puts the comment in the
// assignee's mailbox (read when its next run starts) and steers the run working
// on the task right now, when one is registered. A finished task, an unassigned
// one, and an agent's own comment forward nothing.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  claimTask,
  createTask,
  listUndeliveredInbox,
  teams,
  updateStatus,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { getDb, resetDb } = await import('../../lib/db')
const { boardCommentPOST } = await import('../board')
const { registerRunSteer, resetRunSteers } = await import('../../lib/runSteers')

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

function comment(taskId: string, body: string, authorType: 'user' | 'agent' = 'user') {
  const r = mockRes()
  boardCommentPOST({ params: { taskId }, body: { body, authorType } } as unknown as Request, r.res)
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

  it('puts the comment in the assignee’s mailbox', () => {
    const taskId = runningTask()
    const r = comment(taskId, 'Lead with the pricing change.')
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
    comment(taskId, 'Keep it short.')
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
    const r = comment(taskId, 'Nice work.')
    await settle()
    expect((r.body() as { forwarded: boolean }).forwarded).toBe(false)
    expect(listUndeliveredInbox(getDb(), 'coder', { teamId: TEAM })).toHaveLength(0)
    expect(run.steers).toHaveLength(0)
    run.release()
  })

  it('forwards nothing for an unassigned task or an agent’s own comment', () => {
    const db = getDb()
    const loose = createTask(db, { title: 'Nobody yet', teamId: TEAM, status: 'todo' })
    expect((comment(loose.id, 'Anyone?').body() as { forwarded: boolean }).forwarded).toBe(false)
    const taskId = runningTask()
    expect(
      (comment(taskId, 'Done step 1', 'agent').body() as { forwarded: boolean }).forwarded,
    ).toBe(false)
    expect(listUndeliveredInbox(db, 'coder', { teamId: TEAM })).toHaveLength(0)
  })
})
