// Only the team engine's own board client marks a run as the engine's. Anyone can name
// an executor on the executions route, including the name the engine's runs carry, and
// nothing in a request can make a run read as the engine's.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { claimTask, createTask, listExecutions, teams, type ClawbooDb } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../../lib/db'
import { createServerBoardClient } from '../../lib/teamChat/serverBoardClient'
import { boardExecutionCreatePOST } from '../board'

const TEAM = 'T'

function mockRes(): { res: Response; statusCode: () => number } {
  let code = 200
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json() {
      return this
    },
  } as unknown as Response
  return { res, statusCode: () => code }
}

describe('the engine marker, by who opens the run', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-engine-run-route-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: TEAM, name: 'T', icon: 'x', color: '#000', createdAt: now, updatedAt: now })
      .run()
  })

  afterEach(async () => {
    resetDb()
    for (const k of ['HOME', 'CLAWBOO_HOME']) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    await rm(home, { recursive: true, force: true })
  })

  it('a request naming the engine’s label does not make the engine’s run', () => {
    const t = createTask(db, { title: 'x', teamId: TEAM })
    claimTask(db, t.id, 'a1')
    const m = mockRes()
    boardExecutionCreatePOST(
      {
        params: { taskId: t.id },
        body: { executorType: 'openclaw', engineRun: 1, engine_run: 1 },
      } as unknown as Request,
      m.res,
    )
    expect(m.statusCode()).toBe(200)
    expect(listExecutions(db, t.id).at(-1)).toMatchObject({
      executorType: 'openclaw',
      engineRun: 0,
    })
  })

  it('the engine’s board client marks what it opens, and reports the marker back', async () => {
    const board = createServerBoardClient(db)

    const claimed = createTask(db, { title: 'claimed', teamId: TEAM })
    const claim = await board.claim(claimed.id, 'a1', 'openclaw', { executorType: 'openclaw' })
    expect(claim.ok).toBe(true)
    expect(listExecutions(db, claimed.id).at(-1)?.engineRun).toBe(1)

    const opened = createTask(db, { title: 'opened', teamId: TEAM })
    claimTask(db, opened.id, 'a1')
    await board.createExecution(opened.id, 'openclaw')
    expect(listExecutions(db, opened.id).at(-1)?.engineRun).toBe(1)
    expect((await board.listExecutions(opened.id))?.at(-1)?.engineRun).toBe(1)
  })
})
