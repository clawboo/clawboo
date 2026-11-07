// A task runner run keeps its row open while its work is checked, with the task In
// review. If its process dies, nothing beats the task any more. The sweep parks
// such a task for a person, once the beat has been silent for the whole window. A
// team-chat check is the engine's to park, and it does not beat, so it is left alone.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { tasks } from '../../schema'
import {
  claimTask,
  createExecutionProcess,
  createTask,
  getComments,
  getTask,
  listExecutions,
  ORPHANED_REVIEW_NOTE,
  reconcileStaleInReview,
  startReviewHeartbeat,
  TASK_HEARTBEAT_MS,
  updateStatus,
} from '../repository'
import { setTaskRunnerInputs } from '../runnerInputs'
import { adoptTaskWakes, listWaitingTaskWakes, recordTaskWake } from '../../taskWakes'
import { eq } from 'drizzle-orm'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-stale-review-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

function inReview(executorType: string | null, runnerRan = true): string {
  const id = createTask(db, { title: 'Check me', teamId: 'T', status: 'todo' }).id
  expect(claimTask(db, id, 'coder', 'claude-code').ok).toBe(true)
  // What the runner saves when it claims a task.
  if (runnerRan)
    setTaskRunnerInputs(db, id, {
      runtime: 'claude-code',
      assigneeAgentId: 'coder',
      repoPath: null,
      kind: null,
      model: null,
    })
  if (executorType) createExecutionProcess(db, { taskId: id, executorType })
  expect(updateStatus(db, id, 'in_review').ok).toBe(true)
  return id
}

const age = (id: string): void => {
  db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, id)).run()
}

describe('reconcileStaleInReview', () => {
  it('gives back a saved wake the run carried, and lets go of the run stamp', () => {
    const id = inReview('claude-code')
    const exec = listExecutions(db, id).at(-1)!
    db.update(tasks).set({ runExecutionId: exec.id }).where(eq(tasks.id, id)).run()
    const wake = recordTaskWake(db, {
      teamId: 'T',
      agentId: 'coder',
      taskId: id,
      reason: 'person_comment',
    })
    adoptTaskWakes(db, id, exec.id)
    age(id)
    expect(reconcileStaleInReview(db, 1_000).reconciled).toBe(1)
    expect(getTask(db, id)?.runExecutionId).toBeNull()
    const row = listWaitingTaskWakes(db).find((w) => w.id === wake.id)
    expect(row?.replays).toBe(1)
    expect(row?.heldAt).toBeNull()
  })

  it('parks a task whose open runner run stopped beating, and says which', () => {
    const id = inReview('claude-code')
    age(id)
    const result = reconcileStaleInReview(db, 60_000)
    expect(result.reconciled).toBe(1)
    expect(result.parked).toEqual([{ taskId: id, teamId: 'T', agentId: 'coder' }])
    const task = getTask(db, id)
    expect(task?.status).toBe('blocked')
    // Assignee stays: the card still says whose work it is.
    expect(task?.assigneeAgentId).toBe('coder')
    const [run] = listExecutions(db, id)
    expect(run).toMatchObject({ status: 'failed', recoveryTombstone: 1 })
    expect(getComments(db, id).map((c) => c.body)).toEqual([ORPHANED_REVIEW_NOTE])
    // Idempotent: nothing is left to park.
    expect(reconcileStaleInReview(db, 60_000).reconciled).toBe(0)
    expect(getComments(db, id)).toHaveLength(1)
  })

  it('leaves a run still beating', () => {
    const id = inReview('claude-code')
    expect(reconcileStaleInReview(db, 60_000).reconciled).toBe(0)
    expect(getTask(db, id)?.status).toBe('in_review')
    expect(listExecutions(db, id)[0]?.status).toBe('running')
  })

  it.each(['openclaw', 'openclaw-routine'])(
    'leaves a %s run, whose driver does not beat a task in review',
    (executorType) => {
      const id = inReview(executorType)
      age(id)
      expect(reconcileStaleInReview(db, 60_000).reconciled).toBe(0)
      expect(getTask(db, id)?.status).toBe('in_review')
    },
  )

  it('leaves a run some other executor opened: its silence says nothing about a restart', () => {
    // POST /api/board/:taskId/executions takes any executor type, and such a caller
    // has no way to beat a task. Neither on a task the runner never ran, nor on one
    // it did, under another name.
    const never = inReview('my-ci', false)
    const other = inReview('my-ci')
    const sameName = inReview('claude-code', false)
    for (const id of [never, other, sameName]) age(id)
    expect(reconcileStaleInReview(db, 60_000).reconciled).toBe(0)
    for (const id of [never, other, sameName]) {
      expect(getTask(db, id)?.status).toBe('in_review')
      expect(listExecutions(db, id)[0]?.status).toBe('running')
      expect(getComments(db, id)).toEqual([])
    }
  })

  it('leaves a task in review with no open run', () => {
    const id = inReview(null)
    age(id)
    expect(reconcileStaleInReview(db, 60_000).reconciled).toBe(0)
    expect(getTask(db, id)?.status).toBe('in_review')
  })

  it('leaves a stale task that is not in review', () => {
    const id = createTask(db, { title: 'Working', teamId: 'T', status: 'todo' }).id
    claimTask(db, id, 'coder', 'claude-code')
    createExecutionProcess(db, { taskId: id, executorType: 'claude-code' })
    age(id)
    expect(reconcileStaleInReview(db, 60_000).reconciled).toBe(0)
    expect(getTask(db, id)?.status).toBe('in_progress')
  })
})

describe('startReviewHeartbeat', () => {
  it('beats a task in review on a timer, and stops when told', () => {
    vi.useFakeTimers()
    const id = inReview('claude-code')
    const stop = startReviewHeartbeat(db, id, { assigneeAgentId: 'coder' })
    age(id)
    vi.advanceTimersByTime(TASK_HEARTBEAT_MS)
    const beaten = getTask(db, id)!.updatedAt
    expect(beaten).toBeGreaterThan(1)

    stop()
    age(id)
    vi.advanceTimersByTime(TASK_HEARTBEAT_MS * 2)
    expect(getTask(db, id)!.updatedAt).toBe(1)
  })

  it('does not beat a task that left review, or one another agent holds', () => {
    vi.useFakeTimers()
    const id = inReview('claude-code')
    const stop = startReviewHeartbeat(db, id, { assigneeAgentId: 'someone-else' })
    age(id)
    vi.advanceTimersByTime(TASK_HEARTBEAT_MS)
    expect(getTask(db, id)!.updatedAt).toBe(1)
    stop()

    const mine = startReviewHeartbeat(db, id, { assigneeAgentId: 'coder' })
    expect(updateStatus(db, id, 'blocked').ok).toBe(true)
    age(id)
    vi.advanceTimersByTime(TASK_HEARTBEAT_MS)
    expect(getTask(db, id)!.updatedAt).toBe(1)
    mine()
  })
})
