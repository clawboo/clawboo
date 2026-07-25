import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { executionProcesses } from '../../schema'
import {
  addComment,
  cancelDependents,
  claimTask,
  createExecutionProcess,
  createSubtask,
  createTask,
  dropTask,
  getAncestors,
  getComments,
  getDependents,
  getReadyTasks,
  getTask,
  linkDep,
  listTasks,
  reconcileOrphans,
  reconcileStaleInProgress,
  TaskDependencyCycleError,
  updateStatus,
  updateTaskFields,
} from '../repository'
import { canTransition, isLocked, isTerminal } from '../state-machine'

let dir: string
let dbPath: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-board-'))
  dbPath = path.join(dir, 'test.db')
  db = createDb(dbPath)
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('updateTaskFields — cost + runtime (board card ledger)', () => {
  it('writes costUsd + the real assigneeRuntime; the engine creates a task at 0 / hardcoded openclaw', () => {
    // The engine creates a task with cost 0 and assigneeRuntime 'openclaw' regardless of
    // the real runtime; the orchestrator corrects both on the run terminal.
    const t = createTask(db, { title: 'poem', teamId: 'team1', assigneeRuntime: 'openclaw' })
    expect(getTask(db, t.id)!.costUsd).toBe(0)

    updateTaskFields(db, t.id, { costUsd: 0.0042, assigneeRuntime: 'hermes' })
    const after = getTask(db, t.id)!
    expect(after.costUsd).toBeCloseTo(0.0042)
    expect(after.assigneeRuntime).toBe('hermes')

    // A later cost-only write updates cost without disturbing the runtime.
    updateTaskFields(db, t.id, { costUsd: 0.01 })
    const again = getTask(db, t.id)!
    expect(again.costUsd).toBeCloseTo(0.01)
    expect(again.assigneeRuntime).toBe('hermes')
  })
})

describe('atomic claim', () => {
  it('exactly one of two concurrent claims wins; the loser gets a conflict (no retry)', () => {
    const task = createTask(db, { title: 'claim me', teamId: 'team1' })
    // Two independent connections to the SAME file — simulates two agents racing.
    const dbA = createDb(dbPath)
    const dbB = createDb(dbPath)

    const a = claimTask(dbA, task.id, 'agent-a')
    const b = claimTask(dbB, task.id, 'agent-b')

    const winners = [a, b].filter((r) => r.ok)
    const losers = [a, b].filter((r) => !r.ok)
    expect(winners).toHaveLength(1)
    expect(losers).toHaveLength(1)
    expect(losers[0]?.reason).toBe('conflict')

    const fresh = getTask(db, task.id)
    expect(fresh?.status).toBe('in_progress')
    expect(fresh?.assigneeAgentId).toBe(winners[0]?.task?.assigneeAgentId)
  })

  it('claiming an unknown task returns not_found', () => {
    const r = claimTask(db, 'does-not-exist', 'agent-a')
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('not_found')
  })

  it('a second claim on an already-claimed task is a conflict', () => {
    const task = createTask(db, { title: 't' })
    expect(claimTask(db, task.id, 'agent-a').ok).toBe(true)
    const second = claimTask(db, task.id, 'agent-b')
    expect(second.ok).toBe(false)
    expect(second.reason).toBe('conflict')
  })
})

describe('refresh-survival', () => {
  it('tasks + statuses persist across a reopen of the same file', () => {
    const t = createTask(db, { title: 'persist me', teamId: 'team1' })
    claimTask(db, t.id, 'agent-a')
    updateStatus(db, t.id, 'in_review')

    // "Restart the server": discard the instance, reopen the same path.
    const reopened = createDb(dbPath)
    const fresh = getTask(reopened, t.id)
    expect(fresh).toBeTruthy()
    expect(fresh?.title).toBe('persist me')
    expect(fresh?.status).toBe('in_review')
    expect(fresh?.assigneeAgentId).toBe('agent-a')
  })
})

describe('orphan reconciliation', () => {
  it('a running exec on restart → failed + tombstoned, task released; second pass is a no-op', () => {
    const t = createTask(db, { title: 'orphan', teamId: 'team1' })
    claimTask(db, t.id, 'agent-a') // → in_progress
    const ex = createExecutionProcess(db, { taskId: t.id, executorType: 'openclaw' }) // → running

    // Simulate restart.
    const reopened = createDb(dbPath)
    const r1 = reconcileOrphans(reopened)
    expect(r1.reconciled).toBe(1)

    const execRow = reopened
      .select()
      .from(executionProcesses)
      .where(eq(executionProcesses.id, ex.id))
      .get()
    expect(execRow?.status).toBe('failed')
    expect(execRow?.recoveryTombstone).toBe(1)

    const taskAfter = getTask(reopened, t.id)
    expect(taskAfter?.status).toBe('todo')
    expect(taskAfter?.assigneeAgentId).toBeNull()

    // Idempotent: the tombstone prevents infinite auto-resume.
    const r2 = reconcileOrphans(reopened)
    expect(r2.reconciled).toBe(0)
    expect(getTask(reopened, t.id)?.status).toBe('todo')
  })
})

describe('downstream-chain recovery + stale sweep', () => {
  it('getDependents returns the transitive downstream set', () => {
    const a = createTask(db, { title: 'a' })
    const b = createTask(db, { title: 'b' })
    const c = createTask(db, { title: 'c' })
    linkDep(db, b.id, a.id) // b depends on a
    linkDep(db, c.id, b.id) // c depends on b
    expect(
      getDependents(db, a.id)
        .map((t) => t.id)
        .sort(),
    ).toEqual([b.id, c.id].sort())
  })

  it('cancelDependents cancels pending downstream, leaves running/done untouched', () => {
    const a = createTask(db, { title: 'a' })
    const b = createTask(db, { title: 'b' }) // todo (cancelable)
    const c = createTask(db, { title: 'c' }) // will be in_progress (not cancelable)
    linkDep(db, b.id, a.id)
    linkDep(db, c.id, a.id)
    claimTask(db, c.id, 'agent-x')
    const cancelled = cancelDependents(db, a.id)
    expect(cancelled.map((t) => t.id)).toEqual([b.id])
    expect(getTask(db, b.id)!.status).toBe('cancelled')
    expect(getTask(db, c.id)!.status).toBe('in_progress')
  })

  it('reconcileStaleInProgress releases a stale in_progress task + times out its running exec', () => {
    const t = createTask(db, { title: 'hung' })
    claimTask(db, t.id, 'agent-x')
    const ex = createExecutionProcess(db, { taskId: t.id, executorType: 'openclaw' })
    // A fresh task is NOT swept (TTL not exceeded).
    expect(reconcileStaleInProgress(db, 60_000).reconciled).toBe(0)
    expect(getTask(db, t.id)!.status).toBe('in_progress')
    // A future cutoff (negative TTL) sweeps it: task → todo, exec → timed_out.
    expect(reconcileStaleInProgress(db, -10_000).reconciled).toBe(1)
    expect(getTask(db, t.id)!.status).toBe('todo')
    const exRow = db
      .select()
      .from(executionProcesses)
      .where(eq(executionProcesses.id, ex.id))
      .get() as { status: string }
    expect(exRow.status).toBe('timed_out')
  })
})

describe('state machine', () => {
  it('allows legal transitions', () => {
    expect(canTransition('todo', 'in_progress')).toBe(true)
    expect(canTransition('in_progress', 'in_review')).toBe(true)
    expect(canTransition('in_review', 'done')).toBe(true)
    expect(canTransition('in_progress', 'todo')).toBe(true) // release path
    expect(canTransition('todo', 'todo')).toBe(true) // idempotent
  })

  it('rejects illegal transitions', () => {
    expect(canTransition('todo', 'done')).toBe(false) // must pass through in_progress
    expect(canTransition('backlog', 'done')).toBe(false)
    expect(canTransition('done', 'todo')).toBe(false) // terminal
    expect(canTransition('cancelled', 'in_progress')).toBe(false) // terminal
  })

  it('reports locks + terminals', () => {
    expect(isLocked('in_progress')).toBe(true)
    expect(isLocked('in_review')).toBe(true)
    expect(isLocked('todo')).toBe(false)
    expect(isTerminal('done')).toBe(true)
    expect(isTerminal('cancelled')).toBe(true)
    expect(isTerminal('todo')).toBe(false)
  })

  it('updateStatus enforces the state machine + stamps completedAt', () => {
    const t = createTask(db, { title: 'x' }) // 'todo'
    const illegal = updateStatus(db, t.id, 'done')
    expect(illegal.ok).toBe(false)
    expect(illegal.reason).toBe('illegal_transition')

    claimTask(db, t.id, 'agent-a') // → in_progress
    const ok = updateStatus(db, t.id, 'done')
    expect(ok.ok).toBe(true)
    expect(ok.task?.status).toBe('done')
    expect(ok.task?.completedAt).toBeTypeOf('number')
  })

  it('updateStatus → todo UNASSIGNS the task so the atomic claim can re-acquire it', () => {
    const t = createTask(db, { title: 'release me' })
    expect(claimTask(db, t.id, 'agent-a').ok).toBe(true) // in_progress, assigned
    const released = updateStatus(db, t.id, 'todo')
    expect(released.ok).toBe(true)
    expect(released.task?.status).toBe('todo')
    expect(released.task?.assigneeAgentId).toBeNull() // cleared → re-claimable
    // A different agent can now win it (the claim guard requires assignee IS NULL).
    const reclaim = claimTask(db, t.id, 'agent-b')
    expect(reclaim.ok).toBe(true)
    expect(reclaim.task?.assigneeAgentId).toBe('agent-b')
  })
})

describe('dependencies, lineage, comments, soft-delete', () => {
  it('rejects a direct dependency cycle without changing readiness', () => {
    const a = createTask(db, { title: 'A' })
    const b = createTask(db, { title: 'B' })
    linkDep(db, b.id, a.id)

    expect(() => linkDep(db, a.id, b.id)).toThrow(TaskDependencyCycleError)
    expect(getReadyTasks(db).map((task) => task.id)).toContain(a.id)
  })

  it('rejects a transitive dependency cycle', () => {
    const a = createTask(db, { title: 'A' })
    const b = createTask(db, { title: 'B' })
    const c = createTask(db, { title: 'C' })
    linkDep(db, b.id, a.id)
    linkDep(db, c.id, b.id)

    expect(() => linkDep(db, a.id, c.id)).toThrow(TaskDependencyCycleError)
  })

  it('getReadyTasks excludes tasks with unsatisfied dependencies', () => {
    const a = createTask(db, { title: 'A' })
    const b = createTask(db, { title: 'B' })
    linkDep(db, b.id, a.id) // B depends on A

    let ready = getReadyTasks(db).map((t) => t.id)
    expect(ready).toContain(a.id)
    expect(ready).not.toContain(b.id)

    claimTask(db, a.id, 'agent-a')
    updateStatus(db, a.id, 'done')

    ready = getReadyTasks(db).map((t) => t.id)
    expect(ready).toContain(b.id)
  })

  it('getAncestors walks the parent chain (zod-validated raw CTE)', () => {
    const root = createTask(db, { title: 'root' })
    const child = createSubtask(db, root.id, { title: 'child' })
    const grand = createSubtask(db, child.id, { title: 'grand' })

    const ancestors = getAncestors(db, grand.id).map((r) => r.id)
    expect(ancestors).toContain(child.id)
    expect(ancestors).toContain(root.id)
    expect(ancestors).not.toContain(grand.id)
  })

  it('comments persist; soft-delete hides a task by default', () => {
    const t = createTask(db, { title: 'c' })
    addComment(db, t.id, 'hello', 'user')
    expect(getComments(db, t.id)).toHaveLength(1)

    dropTask(db, t.id)
    expect(listTasks(db)).toHaveLength(0)
    expect(listTasks(db, { includeDropped: true })).toHaveLength(1)
  })
})
