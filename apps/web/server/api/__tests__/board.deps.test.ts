// The dependency-link REST route: a cycle is a client mistake (409), not a server
// fault (500). `linkDep` throws TaskDependencyCycleError; without a catch it fell
// into the generic handler and surfaced a stringified exception behind a 500.
// Sandboxes $HOME so the sqlite db lands in a throwaway dir (the route reads
// getDbPath()).

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDb, createTask, getDependents } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../../lib/db'
import { boardLinkDepPOST } from '../board'

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
  ({ params: {}, query: {}, body: {}, ...over }) as unknown as Request

const link = (taskId: string, dependsOnTaskId: string) => {
  const r = mockRes()
  boardLinkDepPOST(req({ params: { taskId }, body: { dependsOnTaskId } }), r.res)
  return r
}

describe('POST /api/board/:taskId/deps — cycle rejection', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-deps-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('a link that would close a cycle is 409, not 500, and no edge is written', () => {
    const db = createDb(getDbPath())
    const a = createTask(db, { title: 'A' })
    const b = createTask(db, { title: 'B' })

    expect(link(b.id, a.id).statusCode()).toBe(200)

    const cycle = link(a.id, b.id)
    expect(cycle.statusCode()).toBe(409)
    expect((cycle.body() as { error: string }).error).toBe('task_dependency_cycle')
    // The rejected edge never landed: A still has exactly one dependent (B).
    expect(getDependents(db, a.id).map((t) => t.id)).toEqual([b.id])
  })

  it('a link to a task that does not exist is still 404', () => {
    const db = createDb(getDbPath())
    const a = createTask(db, { title: 'A' })
    expect(link(a.id, 'no-such-task').statusCode()).toBe(404)
  })
})
