// Observability wiring at the board REST choke-points: each successful mutation
// emits the matching orchestration event. Sandboxes $HOME so the sqlite db is a
// throwaway. The pure @clawboo/db/board/repository.ts is UNTOUCHED — emits live in
// the REST handler.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDb, listEvents, readRoom, resolveRoomForTeam } from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../../lib/db'
import {
  boardClaimPOST,
  boardCommentPOST,
  boardCreatePOST,
  boardExecutionCompletePATCH,
  boardExecutionCreatePOST,
  boardLinkDepPOST,
  boardUpdatePATCH,
} from '../board'

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
const req = (body: unknown, params: Record<string, string> = {}): Request =>
  ({ body, query: {}, params }) as unknown as Request

function kindsInLog(): string[] {
  return listEvents(createDb(getDbPath()), { limit: 1000 }).map((e) => e.kind)
}

describe('board REST → observability emits', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-board-obs-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('emits the matching event for each of the 7 board mutations', () => {
    // create
    const c1 = mockRes()
    boardCreatePOST(req({ title: 'Root', teamId: 'team1' }), c1.res)
    const rootId = (c1.body() as { task: { id: string } }).task.id
    const c2 = mockRes()
    boardCreatePOST(req({ title: 'Child', teamId: 'team1' }), c2.res)
    const childId = (c2.body() as { task: { id: string } }).task.id

    // claim → in_progress
    boardClaimPOST(
      req({ assigneeAgentId: 'a1', assigneeRuntime: 'openclaw' }, { taskId: rootId }),
      mockRes().res,
    )
    // status transition (in_progress → in_review is legal)
    boardUpdatePATCH(req({ status: 'in_review' }, { taskId: rootId }), mockRes().res)
    // comment
    boardCommentPOST(
      req({ body: 'report', authorType: 'agent', authorAgentId: 'a1' }, { taskId: rootId }),
      mockRes().res,
    )
    // dep: child depends on root
    boardLinkDepPOST(req({ dependsOnTaskId: rootId }, { taskId: childId }), mockRes().res)
    // execution start + complete
    const ex = mockRes()
    boardExecutionCreatePOST(req({ executorType: 'openclaw' }, { taskId: rootId }), ex.res)
    const execId = (ex.body() as { execution: { id: string } }).execution.id
    boardExecutionCompletePATCH(
      req({ status: 'succeeded', costUsd: 0.01 }, { execId }),
      mockRes().res,
    )

    const kinds = kindsInLog()
    expect(kinds.filter((k) => k === 'task_created')).toHaveLength(2)
    for (const k of [
      'task_claimed',
      'status_changed',
      'comment_added',
      'dep_linked',
      'execution_started',
      'execution_completed',
    ]) {
      expect(kinds).toContain(k)
    }
  })

  it('narrates claim / comment / dep board mutations into the team room (fan-out to N peers)', () => {
    const c = mockRes()
    boardCreatePOST(req({ title: 'Root', teamId: 'team1' }), c.res)
    const rootId = (c.body() as { task: { id: string } }).task.id
    const c2 = mockRes()
    boardCreatePOST(req({ title: 'Child', teamId: 'team1' }), c2.res)
    const childId = (c2.body() as { task: { id: string } }).task.id

    boardClaimPOST(
      req({ assigneeAgentId: 'a1', assigneeRuntime: 'openclaw' }, { taskId: rootId }),
      mockRes().res,
    )
    boardCommentPOST(
      req({ body: 'report up', authorType: 'agent', authorAgentId: 'a1' }, { taskId: rootId }),
      mockRes().res,
    )
    boardLinkDepPOST(req({ dependsOnTaskId: rootId }, { taskId: childId }), mockRes().res)

    // Each non-status board mutation now narrates a `kind:'system'` line into the
    // team room (before this fix only status changes reflected).
    const room = readRoom(createDb(getDbPath()), { roomId: resolveRoomForTeam('team1') })
    expect(room.length).toBeGreaterThanOrEqual(3)
    expect(room.every((r) => r.kind === 'system' && r.authorAgentId === 'clawboo')).toBe(true)
    const bodies = room.map((r) => r.body)
    expect(bodies.some((b) => /claimed by a1/.test(b))).toBe(true)
    expect(bodies.some((b) => /report up/.test(b))).toBe(true)
    expect(bodies.some((b) => /depends on/.test(b))).toBe(true)
  })
})
