// What the board REST hands a card about cost. Each task carries `runCost`, the sum
// of its runs read off the execution ledger, so a task that ran twice shows both
// runs and an estimate is marked as one. Sandboxes $HOME so the sqlite db is a
// throwaway.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  createExecutionProcess,
  createTask,
  getTask,
  listExecutions,
  recordExecutionUsage,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../../lib/db'
import { boardCreatePOST, boardExecutionCompletePATCH, boardGetGET, boardListGET } from '../board'

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
const req = (
  body: unknown,
  params: Record<string, string> = {},
  query: Record<string, string> = {},
): Request => ({ body, query, params }) as unknown as Request

type Card = { id: string; runCost: { usd: number | null; estimated: boolean } }

describe('board REST: run cost on every card', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-cost-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('lists each task with what its runs cost, and none for a task that never ran', () => {
    const db = getDb()
    const idle = createTask(db, { title: 'Never ran', teamId: 'team1' })
    const ran = createTask(db, { title: 'Ran twice', teamId: 'team1' })
    for (const usd of [0.1, 0.32]) {
      const exec = createExecutionProcess(db, { taskId: ran.id, executorType: 'claude-code' })
      recordExecutionUsage(db, exec.id, { costUsd: usd, costSource: 'reported' })
    }

    const r = mockRes()
    boardListGET(req({}, {}, { teamId: 'team1' }), r.res)
    expect(r.statusCode()).toBe(200)
    const cards = (r.body() as { tasks: Card[] }).tasks
    expect(cards.find((c) => c.id === idle.id)!.runCost).toEqual({ usd: null, estimated: false })
    const costed = cards.find((c) => c.id === ran.id)!.runCost
    expect(costed.usd).toBeCloseTo(0.42, 12)
    expect(costed.estimated).toBe(false)
  })

  it('a single task and a newly created one carry runCost too', () => {
    const db = getDb()
    const t = createTask(db, { title: 'Estimated', teamId: 'team1' })
    const exec = createExecutionProcess(db, { taskId: t.id, executorType: 'openclaw' })
    recordExecutionUsage(db, exec.id, { costUsd: 0.02, costSource: 'char-estimate' })

    const g = mockRes()
    boardGetGET(req({}, { taskId: t.id }), g.res)
    expect((g.body() as { task: Card }).task.runCost).toEqual({ usd: 0.02, estimated: true })

    const c = mockRes()
    boardCreatePOST(req({ title: 'Fresh', teamId: 'team1' }), c.res)
    expect((c.body() as { task: Card }).task.runCost).toEqual({ usd: null, estimated: false })
  })

  it('a run closed with a reported cost stores its source and refreshes the task total', () => {
    const db = getDb()
    const t = createTask(db, { title: 'Closed by a runner', teamId: 'team1' })
    const exec = createExecutionProcess(db, { taskId: t.id, executorType: 'claude-code' })

    const r = mockRes()
    boardExecutionCompletePATCH(
      req({ status: 'succeeded', costUsd: 0.3, costSource: 'reported' }, { execId: exec.id }),
      r.res,
    )
    expect(r.statusCode()).toBe(200)
    const [row] = listExecutions(db, t.id)
    expect(row!.costUsd).toBeCloseTo(0.3, 12)
    expect(row!.costSource).toBe('reported')
    expect(getTask(db, t.id)!.costUsd).toBeCloseTo(0.3, 12)
  })

  it('rejects a cost source it does not know', () => {
    const db = getDb()
    const t = createTask(db, { title: 'Bogus', teamId: 'team1' })
    const exec = createExecutionProcess(db, { taskId: t.id, executorType: 'claude-code' })

    const r = mockRes()
    boardExecutionCompletePATCH(
      req({ status: 'succeeded', costUsd: 0.3, costSource: 'bogus' }, { execId: exec.id }),
      r.res,
    )
    expect(r.statusCode()).toBe(400)
    expect(listExecutions(db, t.id)[0]!.status).toBe('running')
  })

  it('rejects a null cost: over REST a cost field is a number or left out', () => {
    const db = getDb()
    const t = createTask(db, { title: 'Null cost', teamId: 'team1' })
    const exec = createExecutionProcess(db, { taskId: t.id, executorType: 'claude-code' })

    const r = mockRes()
    boardExecutionCompletePATCH(
      req({ status: 'succeeded', costUsd: null }, { execId: exec.id }),
      r.res,
    )
    expect(r.statusCode()).toBe(400)
    expect(listExecutions(db, t.id)[0]!.status).toBe('running')
  })
})
