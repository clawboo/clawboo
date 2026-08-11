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
  getComments,
  getTask,
  listEvents,
  listExecutions,
  type ClawbooDb,
  type DbOrchestrationEvent,
} from '@clawboo/db'
import {
  projectFleetHealth,
  projectGraph,
  type OrchestrationEvent,
  type OrchestrationEventKind,
} from '@clawboo/obs'

import { getDb, resetDb } from '../../db'
import { createServerBoardClient } from '../serverBoardClient'

/** Rehydrate a stored row into the reducer shape (mirrors api/obs.ts `toEvent`). */
function toObsEvent(row: DbOrchestrationEvent): OrchestrationEvent {
  let data: Record<string, unknown> = {}
  try {
    data = JSON.parse(row.data) as Record<string, unknown>
  } catch {
    data = {}
  }
  return { ...row, kind: row.kind as OrchestrationEventKind, data }
}

const TEAM = 'team-sbc'

describe('serverBoardClient (direct-DB BoardClient over the board repo)', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-sbc-home-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home // → getDbPath() lands in the sandbox
    db = getDb()
  })
  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  // Query ALL events (fresh sandbox DB per test). `comment_added` / `dep_linked`
  // still carry no teamId, so a teamId-filtered query would miss those and the
  // unfiltered list stays the parity check. `execution_completed` no longer
  // belongs on that list: it is now correlated like `execution_started`, which
  // the two tests below pin.
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

  it('execution_completed carries the same correlation columns as execution_started', async () => {
    const client = createServerBoardClient(db)
    const task = await client.createTask({ title: 't', teamId: TEAM })
    await client.claim(task!.id, 'a1')
    const exec = await client.createExecution(task!.id, 'clawboo-native')
    await client.completeExecution(exec!.id, { status: 'succeeded', costUsd: 0.01 })

    // The request only carries an execId, but the closed row carries its taskId,
    // so these are recoverable. Uncorrelated, `projectFleetHealth` skips the
    // completion (it drops any event with no agentId) and the agent reads as a
    // permanent zombie; a teamId-scoped read drops it too, since SQL equality
    // never matches NULL.
    const done = listEvents(db, { kinds: ['execution_completed'] })
    expect(done).toHaveLength(1)
    expect(done[0]!.taskId).toBe(task!.id)
    expect(done[0]!.teamId).toBe(TEAM)
    expect(done[0]!.agentId).toBe('a1')
    // The team-scoped read the dashboards actually issue must see it.
    expect(listEvents(db, { teamId: TEAM, kinds: ['execution_completed'] })).toHaveLength(1)
  })

  it('an unknown execId closes nothing and emits nothing', async () => {
    const client = createServerBoardClient(db)
    const task = await client.createTask({ title: 't', teamId: TEAM })
    await client.claim(task!.id, 'a1')
    await client.createExecution(task!.id, 'clawboo-native')

    await client.completeExecution('no-such-exec', { status: 'succeeded' })

    // A completion for a run that never ended would be uncorrelated by
    // construction (there is no row to recover a taskId from), reintroducing the
    // very event shape the correlation fix removes.
    expect(listEvents(db, { kinds: ['execution_completed'] })).toHaveLength(0)
    expect(listExecutions(db, task!.id)[0]?.status).toBe('running')
  })

  it('a finished run reads idle, not a phantom zombie', async () => {
    const client = createServerBoardClient(db)
    const task = await client.createTask({ title: 't', teamId: TEAM })
    await client.claim(task!.id, 'a1')
    const exec = await client.createExecution(task!.id, 'clawboo-native')
    await client.completeExecution(exec!.id, { status: 'succeeded', costUsd: 0.42 })

    const events = listEvents(db, { teamId: TEAM }).map(toObsEvent)
    // 31 min later: an undecremented open counter would have gone working →
    // stalled → zombie by now, so this pins the decrement, not just the columns.
    const health = projectFleetHealth(events, Date.now() + 31 * 60_000)
    expect(health.get('a1')?.status).toBe('idle')
    expect(health.get('a1')?.openExecutions).toBe(0)
    // And the authoritative run cost lands on the task instead of being skipped.
    expect(projectGraph(events).tasks.find((t) => t.id === task!.id)?.costUsd).toBe(0.42)
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
