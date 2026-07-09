// serverBoardClient parity test — the direct-DB BoardClient over the @clawboo/db
// board repo must produce the SAME task/exec rows + the SAME obs events the REST
// `api/board.ts` handlers emit (minus `reflectToRoom`), and honor the engine's
// never-throw / null / false / 409-never-retried contract. Runs against a REAL
// sqlite DB with `$HOME` sandboxed so it lands in a throwaway dir.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createDb,
  getComments,
  getTask,
  listEvents,
  listExecutions,
  type ClawbooDb,
} from '@clawboo/db'

import { getDbPath } from '../../db'
import { createServerBoardClient } from '../serverBoardClient'

const TEAM = 'team-sbc'

describe('serverBoardClient (direct-DB BoardClient over the board repo)', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-sbc-home-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home // → getDbPath() lands in the sandbox
    db = createDb(getDbPath())
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  // Query ALL events (fresh sandbox DB per test). Note: like api/board.ts, the
  // comment_added / dep_linked / execution_completed events carry no teamId, so a
  // teamId-filtered query would miss them — the unfiltered list is the parity check.
  const kinds = (): string[] => listEvents(db).map((e) => e.kind)

  it('createTask → row + task_created obs', async () => {
    const client = createServerBoardClient(db)
    const task = await client.createTask({ title: 'do X', teamId: TEAM })
    expect(task).not.toBeNull()
    expect(getTask(db, task!.id)?.title).toBe('do X')
    expect(kinds()).toContain('task_created')
  })

  it('claim → in_progress + task_claimed; a second claim is a 409 conflict (never thrown/retried)', async () => {
    const client = createServerBoardClient(db)
    const task = await client.createTask({ title: 'claim me', teamId: TEAM })
    const first = await client.claim(task!.id, 'a1')
    expect(first.ok).toBe(true)
    expect(getTask(db, task!.id)?.status).toBe('in_progress')
    expect(getTask(db, task!.id)?.assigneeAgentId).toBe('a1')
    expect(kinds()).toContain('task_claimed')
    const second = await client.claim(task!.id, 'a2')
    expect(second.ok).toBe(false)
    expect(second.reason).toBe('conflict')
  })

  it('createExecution → exec + execution_started; completeExecution → completed + execution_completed', async () => {
    const client = createServerBoardClient(db)
    const task = await client.createTask({ title: 't', teamId: TEAM })
    await client.claim(task!.id, 'a1')
    const exec = await client.createExecution(task!.id, 'clawboo-native')
    expect(exec).not.toBeNull()
    expect(listExecutions(db, task!.id)).toHaveLength(1)
    expect(kinds()).toContain('execution_started')
    await client.completeExecution(exec!.id, { status: 'succeeded', summary: 'ok', costUsd: 0.01 })
    expect(listExecutions(db, task!.id)[0]?.status).toBe('succeeded')
    expect(kinds()).toContain('execution_completed')
  })

  it('updateStatus(done) on an unverified task → true + done + status_changed; an illegal/unknown transition → false (no throw)', async () => {
    const client = createServerBoardClient(db)
    const task = await client.createTask({ title: 't', teamId: TEAM })
    await client.claim(task!.id, 'a1')
    expect(await client.updateStatus(task!.id, 'done')).toBe(true)
    expect(getTask(db, task!.id)?.status).toBe('done')
    expect(kinds()).toContain('status_changed')
    // done is terminal — a further transition is illegal → false, not a throw.
    expect(await client.updateStatus(task!.id, 'todo')).toBe(false)
    // unknown task → false, not a throw.
    expect(await client.updateStatus('nope', 'done')).toBe(false)
  })

  it('getTask returns {task, comments, ancestors}; addComment lands + comment_added; unknown → null', async () => {
    const client = createServerBoardClient(db)
    const task = await client.createTask({ title: 't', teamId: TEAM })
    await client.addComment(task!.id, 'hello', 'system')
    const detail = await client.getTask(task!.id)
    expect(detail?.task.id).toBe(task!.id)
    expect(Array.isArray(detail?.comments)).toBe(true)
    expect(Array.isArray(detail?.ancestors)).toBe(true)
    expect(getComments(db, task!.id)).toHaveLength(1)
    expect(kinds()).toContain('comment_added')
    expect(await client.getTask('nope')).toBeNull()
  })

  it('linkDep gates getReadyTasks (the plan dep chain) + dep_linked; listTasks returns all', async () => {
    const client = createServerBoardClient(db)
    const a = await client.createTask({ title: 'step 0', teamId: TEAM })
    const b = await client.createTask({ title: 'step 1', teamId: TEAM })
    expect(await client.linkDep(b!.id, a!.id)).toBe(true)
    expect(kinds()).toContain('dep_linked')
    const readyIds = (await client.getReadyTasks(TEAM)).map((t) => t.id)
    expect(readyIds).toContain(a!.id) // a is unblocked
    expect(readyIds).not.toContain(b!.id) // b waits on a (not done)
    expect((await client.listTasks(TEAM)).map((t) => t.id).sort()).toEqual([a!.id, b!.id].sort())
  })

  it("cancelDependents cancels a failed blocker's pending chain + emits per-task status_changed", async () => {
    const client = createServerBoardClient(db)
    const a = await client.createTask({ title: 'blocker', teamId: TEAM })
    const b = await client.createTask({ title: 'dependent', teamId: TEAM })
    await client.linkDep(b!.id, a!.id)
    const cancelled = await client.cancelDependents(a!.id)
    expect(cancelled.map((t) => t.id)).toContain(b!.id)
    expect(getTask(db, b!.id)?.status).toBe('cancelled')
  })
})
