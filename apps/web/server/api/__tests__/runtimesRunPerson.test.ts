// POST /api/runtimes/:id/run starts a run on a board task, which is a person's Retry in
// all but name. So without a person's authority it answers to what the automatic pump
// answers to: a person's move stands, and so does a Stop or a park. A person can run it.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  jobRuns,
  updateStatus,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const started = vi.hoisted(() => ({ ids: [] as string[], automatic: [] as boolean[] }))
vi.mock('../../lib/executorRunner', () => ({
  runTaskOnRuntime: vi.fn(async (input: { taskId: string; automaticStart?: boolean }) => {
    started.ids.push(input.taskId)
    started.automatic.push(input.automaticStart === true)
    return { ok: true, taskId: input.taskId }
  }),
}))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const { runtimesRunPOST } = await import('../runtimes')

const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }

async function run(
  taskId: string,
  headers: Record<string, string> = {},
): Promise<{ code: number; body: Record<string, unknown> }> {
  let code = 200
  let body: Record<string, unknown> = {}
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: Record<string, unknown>) {
      body = b
      return this
    },
    on: () => undefined,
  } as unknown as Response
  await runtimesRunPOST(
    {
      params: { id: 'clawboo-native' },
      query: {},
      body: { taskId },
      headers,
      person: null,
      get: () => 'localhost:18790',
      protocol: 'http',
      socket: {},
      app: { locals: {} },
    } as unknown as Request,
    res,
  )
  return { code, body }
}

let home: string
const prev: Record<string, string | undefined> = {}
beforeEach(async () => {
  started.ids = []
  started.automatic = []
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-run-person-'))
  await mkdir(path.join(home, '.clawboo'), { recursive: true })
  for (const name of ['HOME', 'CLAWBOO_HOME']) prev[name] = process.env[name]
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  expect(getDbPath().startsWith(home)).toBe(true)
})
afterEach(async () => {
  resetDb()
  for (const [name, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(home, { recursive: true, force: true })
})

/** A task whose last run a person stopped. */
function stopped(): string {
  const db = getDb()
  const t = createTask(db, { title: 'x', status: 'todo' })
  const exec = createExecutionProcess(db, { taskId: t.id, executorType: 'codex' })
  completeExecutionProcess(db, exec.id, { status: 'cancelled' })
  return t.id
}

/** A task a person moved back, after no run at all. */
function moved(): string {
  const db = getDb()
  const t = createTask(db, { title: 'x', status: 'todo' })
  updateStatus(db, t.id, 'backlog', { actor: 'person' })
  return t.id
}

describe('POST /api/runtimes/:id/run', () => {
  it('starts a task nobody has acted on, from a script too', async () => {
    const t = createTask(getDb(), { title: 'x', status: 'todo' })
    expect((await run(t.id)).code).toBe(200)
    expect(started.ids).toEqual([t.id])
  })

  it('without a person, does not undo a person’s move', async () => {
    const id = moved()
    expect(await run(id)).toMatchObject({ code: 409, body: { reason: 'person_moved' } })
    expect(started.ids).toEqual([])
  })

  it('without a person, does not undo a Stop', async () => {
    const id = stopped()
    expect(await run(id)).toMatchObject({ code: 409, body: { reason: 'stopped' } })
    expect(started.ids).toEqual([])
  })

  it('a person can run it anyway', async () => {
    const a = moved()
    const b = stopped()
    expect((await run(a, DASHBOARD)).code).toBe(200)
    expect((await run(b, DASHBOARD)).code).toBe(200)
    expect(started.ids).toEqual([a, b])
  })

  it('without a person, waits at the job’s limit, and a start counts toward it', async () => {
    const db = getDb()
    const t = createTask(db, { title: 'x', status: 'todo' })
    const exec = createExecutionProcess(db, { taskId: t.id, executorType: 'codex' })
    completeExecutionProcess(db, exec.id, { status: 'succeeded' })
    expect((await run(t.id)).code).toBe(200)
    expect(started.automatic.at(-1)).toBe(true)
    db.insert(jobRuns)
      .values({
        jobTaskId: t.id,
        runs: 5,
        runLimit: 5,
        updatedAt: Date.now(),
      })
      .onConflictDoUpdate({ target: jobRuns.jobTaskId, set: { runs: 5, runLimit: 5 } })
      .run()
    expect(await run(t.id)).toMatchObject({ code: 409, body: { ok: false, reason: 'job_limit' } })

    // A person's start is free of it, and spends nothing.
    expect((await run(t.id, DASHBOARD)).code).toBe(200)
    expect(started.automatic.at(-1)).toBe(false)
  })

  it('refuses a task whose team is gone, for a person too', async () => {
    const t = createTask(getDb(), { title: 'x', status: 'todo', teamId: 'gone' })
    expect(await run(t.id, DASHBOARD)).toMatchObject({
      code: 409,
      body: { ok: false, reason: 'no_team' },
    })
    expect(started.ids).toEqual([])
  })
})
