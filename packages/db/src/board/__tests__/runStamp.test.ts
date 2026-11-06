// The run stamped on the claim: the task row names the execution that holds it,
// written in the same transaction as the claim, so "who is running this?" has one
// durable answer and a driver from an earlier run cannot keep the task looking
// alive. Claims happen in five places and heartbeats in four; these tests pin the
// repository both go through.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { executionProcesses, tasks } from '../../schema'
import {
  assignTaskDelegation,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getTask,
  heartbeatTask,
  listExecutions,
  reconcileOrphans,
  reconcileStaleInProgress,
  releaseTask,
  startTaskHeartbeat,
  updateStatus,
} from '../repository'
import { eq } from 'drizzle-orm'

let dir: string
let db: ClawbooDb
const RUN = { executorType: 'openclaw', runReason: 'delegation' }

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-run-stamp-'))
  db = createDb(path.join(dir, 'test.db'))
})
afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

const newTask = (): string => createTask(db, { title: 't', teamId: 'T' }).id
const stampOf = (id: string): string | null => getTask(db, id)?.runExecutionId ?? null
const ageTask = (id: string): void => {
  db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, id)).run()
}
const updatedAtOf = (id: string): number => getTask(db, id)!.updatedAt

describe('the claim stamps its run', () => {
  it('writes the execution and the stamp with the claim', () => {
    const id = newTask()
    const claim = claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    expect(claim.ok).toBe(true)
    const exec = claim.execution!
    expect(exec.status).toBe('running')
    expect(exec.executorType).toBe('openclaw')
    expect(exec.runReason).toBe('delegation')
    expect(stampOf(id)).toBe(exec.id)
    expect(claim.task?.runExecutionId).toBe(exec.id)
    expect(listExecutions(db, id).map((e) => e.id)).toEqual([exec.id])
  })

  it('a lost claim writes no run and no stamp', () => {
    const id = newTask()
    const first = claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    const second = claimTask(db, id, 'a2', 'openclaw', { run: RUN })
    expect(second.ok).toBe(false)
    expect(second.reason).toBe('conflict')
    expect(second.execution).toBeUndefined()
    expect(stampOf(id)).toBe(first.execution!.id)
    expect(listExecutions(db, id)).toHaveLength(1)
  })

  it('a claim that opens no run has no stamp, until a run is opened for it', () => {
    const id = newTask()
    // The REST claim and MCP `claim_task`: nothing is running yet.
    expect(claimTask(db, id, 'a1', 'claude-code').ok).toBe(true)
    expect(stampOf(id)).toBeNull()
    const exec = createExecutionProcess(db, { taskId: id, executorType: 'claude-code' })
    expect(stampOf(id)).toBe(exec.id)
  })

  it('refuses a claim that would start a second live run on the task', () => {
    const id = newTask()
    const first = claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    // An operator's release: the row is free, but the run is still going.
    releaseTask(db, id)
    expect(getTask(db, id)?.status).toBe('todo')
    const again = claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    expect(again.ok).toBe(false)
    expect(again.reason).toBe('conflict')
    expect(getTask(db, id)?.status).toBe('todo')
    const running = listExecutions(db, id).filter((e) => e.status === 'running')
    expect(running.map((e) => e.id)).toEqual([first.execution!.id])
    // Once that run has ended, the task can be claimed again.
    completeExecutionProcess(db, first.execution!.id, { status: 'failed', error: 'x' })
    expect(claimTask(db, id, 'a1', 'openclaw', { run: RUN }).ok).toBe(true)
  })

  it("a task nobody holds takes no stamp from a Stop's marker row", () => {
    const id = newTask()
    // A Stop's tombstone: a created-and-cancelled row on a task nobody holds.
    const tomb = createExecutionProcess(db, { taskId: id, executorType: 'openclaw' })
    completeExecutionProcess(db, tomb.id, { status: 'cancelled' })
    expect(stampOf(id)).toBeNull()
  })
})

describe('a run left open behind a released task', () => {
  it('the stale sweep closes it once nothing proves it alive, so the task can run again', () => {
    const id = newTask()
    const exec = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    releaseTask(db, id)
    expect(claimTask(db, id, 'a1', 'openclaw', { run: RUN }).ok).toBe(false)
    // Younger than the TTL: it may still be going.
    expect(reconcileStaleInProgress(db, 60_000).reconciled).toBe(0)
    expect(listExecutions(db, id)[0]!.status).toBe('running')
    db.update(executionProcesses)
      .set({ createdAt: 1 })
      .where(eq(executionProcesses.id, exec.id))
      .run()
    reconcileStaleInProgress(db, 60_000)
    expect(listExecutions(db, id)[0]!.status).toBe('timed_out')
    expect(claimTask(db, id, 'a1', 'openclaw', { run: RUN }).ok).toBe(true)
  })
})

describe('the heartbeat matches the run', () => {
  it("beats for the task's own run", () => {
    const id = newTask()
    const exec = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    ageTask(id)
    heartbeatTask(db, id, { assigneeAgentId: 'a1', execId: exec.id })
    expect(updatedAtOf(id)).toBeGreaterThan(1)
  })

  it('a driver from an earlier claim by the SAME agent cannot keep the new claim alive', () => {
    const id = newTask()
    const old = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    completeExecutionProcess(db, old.id, { status: 'failed', error: 'x' })
    updateStatus(db, id, 'todo')
    const fresh = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    ageTask(id)
    heartbeatTask(db, id, { assigneeAgentId: 'a1', execId: old.id })
    expect(updatedAtOf(id)).toBe(1)
    heartbeatTask(db, id, { assigneeAgentId: 'a1', execId: fresh.id })
    expect(updatedAtOf(id)).toBeGreaterThan(1)
  })

  it('a timer driver follows the run as a fix round moves it', () => {
    const id = newTask()
    let current: string | null = null
    const stop = startTaskHeartbeat(db, id, { assigneeAgentId: 'a1', execId: () => current })
    stop()
    // Before the claim there is no run to prove: nothing was written.
    expect(stampOf(id)).toBeNull()
    current = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!.id
    ageTask(id)
    const stop2 = startTaskHeartbeat(db, id, { assigneeAgentId: 'a1', execId: () => current })
    stop2()
    expect(updatedAtOf(id)).toBeGreaterThan(1)
  })

  it('with no run named, a beat still matches the assignee (a claim with no run)', () => {
    const id = newTask()
    claimTask(db, id, 'a1', 'claude-code')
    ageTask(id)
    heartbeatTask(db, id, { assigneeAgentId: 'a2' })
    expect(updatedAtOf(id)).toBe(1)
    heartbeatTask(db, id, { assigneeAgentId: 'a1' })
    expect(updatedAtOf(id)).toBeGreaterThan(1)
  })
})

describe('the stamp is cleared when the run ends or the task is let go', () => {
  it('at the end of the run', () => {
    const id = newTask()
    const exec = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    completeExecutionProcess(db, exec.id, { status: 'failed', error: 'x' })
    expect(stampOf(id)).toBeNull()
  })

  it('on a release', () => {
    const id = newTask()
    claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    releaseTask(db, id)
    expect(stampOf(id)).toBeNull()
  })

  it('on a move to To do', () => {
    const id = newTask()
    claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    updateStatus(db, id, 'todo')
    expect(stampOf(id)).toBeNull()
  })

  it('on a move to Done or Cancelled', () => {
    for (const to of ['done', 'cancelled'] as const) {
      const id = newTask()
      claimTask(db, id, 'a1', 'openclaw', { run: RUN })
      updateStatus(db, id, to)
      expect(stampOf(id)).toBeNull()
    }
  })

  it('on an Assign of a stranded task', () => {
    const id = newTask()
    claimTask(db, id, 'a1', 'openclaw', { run: RUN })
    db.update(tasks).set({ status: 'blocked' }).where(eq(tasks.id, id)).run()
    assignTaskDelegation(db, id, 'assign:n:agent:a2:origin:human')
    expect(stampOf(id)).toBeNull()
  })

  it('in the stale sweep and the orphan reap', () => {
    const swept = newTask()
    claimTask(db, swept, 'a1', 'openclaw', { run: RUN })
    ageTask(swept)
    expect(reconcileStaleInProgress(db, 1_000).reconciled).toBe(1)
    expect(stampOf(swept)).toBeNull()

    const reaped = newTask()
    claimTask(db, reaped, 'a1', 'openclaw', { run: RUN })
    ageTask(reaped)
    expect(reconcileOrphans(db, { staleAfterMs: 1_000 }).reconciled).toBe(1)
    expect(stampOf(reaped)).toBeNull()
  })

  it('an earlier run ending does not clear a later run', () => {
    const id = newTask()
    const old = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    completeExecutionProcess(db, old.id, { status: 'failed', error: 'x' })
    updateStatus(db, id, 'todo')
    const fresh = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    // A duplicate close of the old row closes nothing and touches nothing.
    expect(completeExecutionProcess(db, old.id, { status: 'failed', error: 'late' })).toBeNull()
    expect(stampOf(id)).toBe(fresh.id)
  })
})

describe('a work check keeps the stamp, and a fix round moves it', () => {
  it('stays through In review while the run is open', () => {
    const id = newTask()
    const exec = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    expect(updateStatus(db, id, 'in_review').ok).toBe(true)
    expect(stampOf(id)).toBe(exec.id)
  })

  it("moves to the fix round's execution", () => {
    const id = newTask()
    const first = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    updateStatus(db, id, 'in_review')
    updateStatus(db, id, 'in_progress')
    completeExecutionProcess(db, first.id, { status: 'succeeded', summary: 'first go' })
    const fix = createExecutionProcess(db, {
      taskId: id,
      executorType: 'openclaw',
      runReason: 'fix_round',
    })
    expect(stampOf(id)).toBe(fix.id)
    expect(listExecutions(db, id).find((e) => e.id === fix.id)?.runReason).toBe('fix_round')
    ageTask(id)
    heartbeatTask(db, id, { assigneeAgentId: 'a1', execId: first.id })
    expect(updatedAtOf(id)).toBe(1)
    heartbeatTask(db, id, { assigneeAgentId: 'a1', execId: fix.id })
    expect(updatedAtOf(id)).toBeGreaterThan(1)
  })
})

describe('the verdict a closed run leaves for the brake', () => {
  const closedRow = (execId: string) =>
    db.select().from(executionProcesses).where(eq(executionProcesses.id, execId)).get()

  it('records no progress for a failed run, and progress for a result', () => {
    const a = newTask()
    const failed = claimTask(db, a, 'a1', 'openclaw', { run: RUN }).execution!
    completeExecutionProcess(db, failed.id, { status: 'failed', error: 'boom' })
    expect(closedRow(failed.id)?.madeProgress).toBe(0)

    const b = newTask()
    const ok = claimTask(db, b, 'a1', 'openclaw', { run: RUN }).execution!
    completeExecutionProcess(db, ok.id, { status: 'succeeded', summary: 'done it' })
    expect(closedRow(ok.id)?.madeProgress).toBe(1)
  })

  it('a sub-task made during the run counts, even when the run then failed', () => {
    const id = newTask()
    const exec = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    createTask(db, { title: 'child', teamId: 'T', parentTaskId: id })
    completeExecutionProcess(db, exec.id, { status: 'failed', error: 'boom' })
    expect(closedRow(exec.id)?.madeProgress).toBe(1)
  })

  it('a sub-task from before the run does not', () => {
    const id = newTask()
    createTask(db, { title: 'old child', teamId: 'T', parentTaskId: id })
    db.update(tasks).set({ createdAt: 1 }).where(eq(tasks.parentTaskId, id)).run()
    const exec = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    completeExecutionProcess(db, exec.id, { status: 'failed', error: 'boom' })
    expect(closedRow(exec.id)?.madeProgress).toBe(0)
  })

  it('a stopped run has no verdict', () => {
    const id = newTask()
    const exec = claimTask(db, id, 'a1', 'openclaw', { run: RUN }).execution!
    completeExecutionProcess(db, exec.id, { status: 'cancelled' })
    expect(closedRow(exec.id)?.madeProgress).toBeNull()
  })
})
