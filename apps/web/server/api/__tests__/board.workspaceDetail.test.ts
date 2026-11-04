// What the task drawer's workspace read answers. The drawer asks on every open,
// and most tasks never get a worktree, so a known task without one is an
// ordinary empty answer rather than a 404 the browser logs as an error. Only an
// unknown task is a 404. Sandboxes $HOME so the sqlite db is a throwaway.

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createTask, createWorkspace } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { boardWorkspaceDetailGET } from '../board'

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
const req = (taskId: string): Request =>
  ({ body: {}, query: {}, params: { taskId } }) as unknown as Request

describe('GET /api/board/:taskId/workspace/detail', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-ws-detail-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('answers an empty state for a task that has no worktree', async () => {
    const task = createTask(getDb(), { title: 'Write the brief', teamId: 'team1' })
    const r = mockRes()
    await boardWorkspaceDetailGET(req(task.id), r.res)
    expect(r.statusCode()).toBe(200)
    expect(r.body()).toEqual({ ok: false, reason: 'no_workspace' })
  })

  it('answers the same for a workspace row that never got a checkout', async () => {
    const db = getDb()
    const task = createTask(db, { title: 'Queued', teamId: 'team1' })
    createWorkspace(db, task.id, home, { worktreePath: null })
    const r = mockRes()
    await boardWorkspaceDetailGET(req(task.id), r.res)
    expect(r.statusCode()).toBe(200)
    expect(r.body()).toEqual({ ok: false, reason: 'no_workspace' })
  })

  it('keeps a 404 for a task that does not exist', async () => {
    const r = mockRes()
    await boardWorkspaceDetailGET(req('no-such-task'), r.res)
    expect(r.statusCode()).toBe(404)
    expect(r.body()).toEqual({ error: 'task not found' })
  })

  it('still answers the task files when the task has a worktree', async () => {
    const db = getDb()
    const task = createTask(db, { title: 'Has a checkout', teamId: 'team1' })
    const wt = path.join(home, 'wt')
    await mkdir(wt, { recursive: true })
    await writeFile(path.join(wt, 'TASK.md'), '# Has a checkout\n')
    createWorkspace(db, task.id, home, { worktreePath: wt })
    const r = mockRes()
    await boardWorkspaceDetailGET(req(task.id), r.res)
    expect(r.statusCode()).toBe(200)
    const body = r.body() as { ok: boolean; sorFiles: Record<string, string> }
    expect(body.ok).toBe(true)
    expect(body.sorFiles['TASK.md']).toBe('# Has a checkout\n')
  })
})
