import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { canTransition, isLocked, isTerminal } from '@clawboo/board-core'
import { eq, sql as dsql } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { executionProcesses, tasks, type DbTask } from '../../schema'
import {
  addComment,
  cancelDependents,
  claimTask,
  createCappedRootTask,
  createCappedSubtask,
  createExecutionProcess,
  createSubtask,
  createTask,
  DEFAULT_MAX_CHILDREN,
  DEFAULT_MAX_DEPTH,
  DEFAULT_MAX_ROOT_CREATES,
  DEFAULT_ROOT_CREATE_WINDOW_MS,
  dropTask,
  getAncestors,
  getComments,
  getDependents,
  getReadyTasks,
  getTask,
  linkDep,
  listTasks,
  completeExecutionProcess,
  heartbeatTask,
  isLedgerAutoFireable,
  listTeamsWithFireableDelegations,
  reconcileOrphans,
  reconcileStaleInProgress,
  TaskDependencyCycleError,
  updateStatus,
  updateTaskFields,
  type GuardedCreateResult,
} from '../repository'

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
  it('a STALE running exec on restart → failed + tombstoned, task released; second pass is a no-op', () => {
    const t = createTask(db, { title: 'orphan', teamId: 'team1' })
    claimTask(db, t.id, 'agent-a') // → in_progress
    const ex = createExecutionProcess(db, { taskId: t.id, executorType: 'openclaw' }) // → running

    // Simulate restart. Negative staleAfterMs = "everything has missed its
    // beats" (the same idiom as the stale-sweep test), so the row is reaped.
    const reopened = createDb(dbPath)
    const r1 = reconcileOrphans(reopened, { staleAfterMs: -10_000 })
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
    const r2 = reconcileOrphans(reopened, { staleAfterMs: -10_000 })
    expect(r2.reconciled).toBe(0)
    expect(getTask(reopened, t.id)?.status).toBe('todo')
  })

  it('a STILL-BEATING running exec is NOT reaped (live sibling process / fast restart)', () => {
    // A second clawboo process on the same state dir — or the old server's
    // drains during a fast dev restart — keeps heartbeating its tasks. The boot
    // pass must not murder those runs; only a run that stopped beating is dead.
    const t = createTask(db, { title: 'alive elsewhere', teamId: 'team1' })
    claimTask(db, t.id, 'agent-a') // fresh claim = fresh beat clock
    createExecutionProcess(db, { taskId: t.id, executorType: 'codex' })

    const reopened = createDb(dbPath)
    expect(reconcileOrphans(reopened).reconciled).toBe(0)
    expect(getTask(reopened, t.id)?.status).toBe('in_progress')
    expect(getTask(reopened, t.id)?.assigneeAgentId).toBe('agent-a')
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

  it('the sweep skips an in_progress task with NO running execution (human-parked card)', () => {
    // A card a human dragged to in_progress has no drain beating it — it must
    // never be snapped back to todo by the beat-based TTL.
    const t = createTask(db, { title: 'manually parked' })
    claimTask(db, t.id, 'human-1')
    expect(reconcileStaleInProgress(db, -10_000).reconciled).toBe(0)
    expect(getTask(db, t.id)!.status).toBe('in_progress')
  })

  it('listTeamsWithFireableDelegations: ready + policy-clean only', () => {
    // Fireable: todo, :agent:-marked, deps satisfied, ledger clean.
    const fireable = createTask(db, {
      title: 'fireable',
      teamId: 'T1',
      sourceDelegationId: 'r1:deleg:agent:a1:reflectTo:leader',
    })
    void fireable
    // Not fireable: user-stopped (cancelled tombstone).
    const stopped = createTask(db, {
      title: 'stopped',
      teamId: 'T2',
      sourceDelegationId: 'r2:deleg:agent:a2:reflectTo:leader',
    })
    const ex = createExecutionProcess(db, { taskId: stopped.id, executorType: 'openclaw' })
    completeExecutionProcess(db, ex.id, { status: 'cancelled' })
    // Not fireable: dep-blocked plan tail.
    const blocker = createTask(db, { title: 'blocker', teamId: 'T3' })
    const tail = createTask(db, {
      title: 'tail',
      teamId: 'T3',
      sourceDelegationId: 'r3:plan:1:agent:a3:reflectTo:leader',
    })
    linkDep(db, tail.id, blocker.id)
    // No marker at all (human card) — never pump-relevant.
    createTask(db, { title: 'manual', teamId: 'T4' })

    expect(listTeamsWithFireableDelegations(db)).toEqual(['T1'])
  })

  it('isLedgerAutoFireable: trailing streak resets on success; cancelled and running park', () => {
    const s = (statuses: string[]) => statuses.map((st, i) => ({ id: `e${i}`, status: st }))
    expect(isLedgerAutoFireable([])).toBe(true)
    expect(isLedgerAutoFireable(s(['failed', 'timed_out']))).toBe(true) // 2 trailing < 3
    expect(isLedgerAutoFireable(s(['failed', 'failed', 'timed_out']))).toBe(false) // capped
    expect(isLedgerAutoFireable(s(['failed', 'failed', 'succeeded', 'failed']))).toBe(true) // reset
    expect(isLedgerAutoFireable(s(['failed', 'cancelled']))).toBe(false) // user Stop
    expect(isLedgerAutoFireable(s(['running']))).toBe(false) // owned
  })

  it('heartbeatTask keeps a driven run out of the sweep, and only touches in_progress', () => {
    // Two identical claimed runs, both aged past the TTL. The ONLY difference is
    // that one beats. Anything less than this passes with `heartbeatTask` stubbed
    // to a no-op: a freshly-created task is younger than any sane TTL, so the
    // sweep would have spared it either way.
    const beating = createTask(db, { title: 'long build' })
    const silent = createTask(db, { title: 'dead build' })
    for (const t of [beating, silent]) {
      claimTask(db, t.id, 'agent-x')
      createExecutionProcess(db, { taskId: t.id, executorType: 'codex' })
    }
    const TTL_MS = 60_000
    const aged = Date.now() - 10 * TTL_MS
    db.update(tasks)
      .set({ updatedAt: aged })
      .where(dsql`${tasks.id} IN (${beating.id}, ${silent.id})`)
      .run()
    expect(getTask(db, beating.id)!.updatedAt).toBe(aged)

    heartbeatTask(db, beating.id)
    // STRICTLY advanced, not merely "not older": a no-op beat leaves it at `aged`.
    expect(getTask(db, beating.id)!.updatedAt).toBeGreaterThan(aged)
    expect(getTask(db, silent.id)!.updatedAt).toBe(aged)

    // One sweep, one difference: the beat is what saves the task.
    expect(reconcileStaleInProgress(db, TTL_MS).reconciled).toBe(1)
    expect(getTask(db, beating.id)!.status).toBe('in_progress')
    expect(getTask(db, silent.id)!.status).toBe('todo')

    // A beat must never resurrect freshness on a task that left in_progress.
    updateStatus(db, beating.id, 'in_review')
    const released = getTask(db, beating.id)!.updatedAt
    heartbeatTask(db, beating.id)
    expect(getTask(db, beating.id)!.updatedAt).toBe(released)
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

describe('guarded creation (per-parent child count, nesting depth, root rate)', () => {
  const childrenOf = (parentId: string) => listTasks(db).filter((t) => t.parentTaskId === parentId)
  /** Narrow the union instead of asserting — `ok: true` guarantees `task`. */
  const created = (r: GuardedCreateResult): DbTask => {
    if (!r.ok) throw new Error(`expected the create to succeed, got ${r.reason}`)
    return r.task
  }
  const denied = (r: GuardedCreateResult) => (r.ok ? null : r)

  it('pins the shipped ceilings — retune them deliberately, never by accident', () => {
    expect(DEFAULT_MAX_CHILDREN).toBe(24)
    expect(DEFAULT_MAX_DEPTH).toBe(2)
    expect(DEFAULT_MAX_ROOT_CREATES).toBe(30)
    expect(DEFAULT_ROOT_CREATE_WINDOW_MS).toBe(300_000)
  })

  it('accepts N children then rejects the N+1th, leaving exactly N on the board', () => {
    const parent = createTask(db, { title: 'parent', teamId: 'team1' })
    const caps = { maxChildren: 3 }
    for (let i = 0; i < 3; i += 1) {
      expect(createCappedSubtask(db, parent.id, { title: `c${i}` }, caps).ok).toBe(true)
    }

    const r = denied(createCappedSubtask(db, parent.id, { title: 'c3' }, caps))
    expect(r?.reason).toBe('child_cap')
    expect(r?.count).toBe(3)
    expect(r?.max).toBe(3)
    expect(childrenOf(parent.id)).toHaveLength(3)
  })

  it('a dropped child frees a slot — soft-delete is the only recovery from the cap', () => {
    const parent = createTask(db, { title: 'parent' })
    const caps = { maxChildren: 2 }
    const first = created(createCappedSubtask(db, parent.id, { title: 'a' }, caps))
    createCappedSubtask(db, parent.id, { title: 'b' }, caps)
    expect(denied(createCappedSubtask(db, parent.id, { title: 'c' }, caps))?.reason).toBe(
      'child_cap',
    )

    dropTask(db, first.id)
    expect(createCappedSubtask(db, parent.id, { title: 'c' }, caps).ok).toBe(true)
  })

  it('a completed child still counts, so a create → complete loop cannot outgrow the cap', () => {
    const parent = createTask(db, { title: 'parent' })
    const caps = { maxChildren: 1 }
    const child = created(createCappedSubtask(db, parent.id, { title: 'a' }, caps))
    claimTask(db, child.id, 'agent-a')
    expect(updateStatus(db, child.id, 'done').ok).toBe(true)

    expect(denied(createCappedSubtask(db, parent.id, { title: 'b' }, caps))?.reason).toBe(
      'child_cap',
    )
  })

  it('rejects a child whose parent is already at the max nesting depth', () => {
    const caps = { maxDepth: 2 }
    const root = createTask(db, { title: 'root' })
    const child = created(createCappedSubtask(db, root.id, { title: 'child' }, caps)) // depth 1
    const grand = created(createCappedSubtask(db, child.id, { title: 'grand' }, caps)) // depth 2
    expect(getAncestors(db, grand.id)).toHaveLength(2)

    const r = denied(createCappedSubtask(db, grand.id, { title: 'great' }, caps))
    expect(r?.reason).toBe('depth_cap')
    expect(r?.max).toBe(2)
  })

  it('an unknown parent is parent_not_found DATA, not a foreign-key exception', () => {
    const before = listTasks(db).length
    expect(denied(createCappedSubtask(db, 'does-not-exist', { title: 'orphan' }))?.reason).toBe(
      'parent_not_found',
    )
    expect(listTasks(db)).toHaveLength(before)
  })

  it('inherits the parent team and counts children written on another connection', () => {
    const parent = createTask(db, { title: 'parent', teamId: 'team1' })
    // A second handle on the SAME file — the two-attached-runtimes shape.
    const other = createDb(dbPath)
    expect(
      created(createCappedSubtask(other, parent.id, { title: 'a' }, { maxChildren: 1 })).teamId,
    ).toBe('team1')

    expect(
      denied(createCappedSubtask(db, parent.id, { title: 'b' }, { maxChildren: 1 }))?.reason,
    ).toBe('child_cap')
  })

  it('rate-caps root creation inside the window, then rejects the next one', () => {
    const caps = { maxRootCreates: 3, windowMs: 300_000 }
    for (let i = 0; i < 3; i += 1) {
      expect(createCappedRootTask(db, { title: `r${i}` }, caps).ok).toBe(true)
    }

    const r = denied(createCappedRootTask(db, { title: 'r3' }, caps))
    expect(r?.reason).toBe('root_rate_cap')
    expect(r?.count).toBe(3)
    expect(r?.max).toBe(3)
    expect(r?.windowMs).toBe(300_000)
    expect(listTasks(db)).toHaveLength(3) // the refusal wrote nothing
  })

  it('a root create outside the window does not count — the rate self-clears', () => {
    const caps = { maxRootCreates: 1, windowMs: 300_000 }
    expect(createCappedRootTask(db, { title: 'old' }, caps).ok).toBe(true)
    expect(denied(createCappedRootTask(db, { title: 'new' }, caps))?.reason).toBe('root_rate_cap')

    // A zero-length window makes every existing row "outside" it, which is the
    // same arithmetic as waiting for the window to roll — no clock mocking needed.
    expect(
      createCappedRootTask(db, { title: 'after' }, { maxRootCreates: 1, windowMs: 0 }).ok,
    ).toBe(true)
  })

  it('counts roots created through the UNCAPPED repository too, so rows cannot be laundered in', () => {
    const caps = { maxRootCreates: 2, windowMs: 300_000 }
    createTask(db, { title: 'via repo a' }) // the REST/orchestrator path
    createTask(db, { title: 'via repo b' })

    expect(denied(createCappedRootTask(db, { title: 'via mcp' }, caps))?.reason).toBe(
      'root_rate_cap',
    )
  })

  it('a subtask is never charged against the root rate cap', () => {
    const root = created(createCappedRootTask(db, { title: 'root' }, { maxRootCreates: 1 }))
    // The parent already used the single root slot; children must still flow.
    expect(createCappedSubtask(db, root.id, { title: 'child' }).ok).toBe(true)
    expect(
      denied(createCappedRootTask(db, { title: 'second root' }, { maxRootCreates: 1 }))?.reason,
    ).toBe('root_rate_cap')
  })

  it('a dropped root frees rate quota early', () => {
    const caps = { maxRootCreates: 1, windowMs: 300_000 }
    const first = created(createCappedRootTask(db, { title: 'a' }, caps))
    expect(denied(createCappedRootTask(db, { title: 'b' }, caps))?.reason).toBe('root_rate_cap')

    dropTask(db, first.id)
    expect(createCappedRootTask(db, { title: 'b' }, caps).ok).toBe(true)
  })
})

describe('guarded-create index coverage', () => {
  // Both cap counts run INSIDE `immediateWrite`, holding the write lock, so an
  // unindexed scan there stalls every other task write on the board. Assert the
  // planner actually USES the composite index rather than just that it exists —
  // a present-but-unused index is the same stall with extra write cost.
  const plan = (sql: string): string =>
    (db.all(dsql.raw(`EXPLAIN QUERY PLAN ${sql}`)) as { detail: string }[])
      .map((r) => r.detail)
      .join(' | ')

  it('the root-rate count is index-backed, not a scan', () => {
    const detail = plan(
      'SELECT count(*) FROM tasks WHERE parent_task_id IS NULL AND dropped = 0 AND created_at > 0',
    )
    expect(detail).toContain('idx_tasks_parent_dropped_created')
    expect(detail).not.toMatch(/SCAN tasks/)
  })

  it('the per-parent child count is index-backed too (an index prefix)', () => {
    const detail = plan("SELECT count(*) FROM tasks WHERE parent_task_id = 'x' AND dropped = 0")
    // The composite by NAME, not a loose /idx_tasks_parent/ — that substring also
    // matches the narrower single-column index, so the assertion would still pass
    // if the planner regressed off the covering path.
    expect(detail).toContain('idx_tasks_parent_dropped_created')
    expect(detail).not.toMatch(/SCAN tasks/)
  })
})
