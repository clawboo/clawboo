// What a run cost lives on the run's own execution row. These tests pin the three
// things the board relies on: a close never erases a cost it was not given, a cost
// can land on a row that is already closed, and the task's own cost column is
// always the sum of its runs.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { executionProcesses, tasks } from '../../schema'
import {
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getTask,
  listExecutions,
  recordExecutionUsage,
} from '../repository'
import { runCostForTask, runCostForTasks } from '../runCost'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-runcost-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

function openRun(taskId: string) {
  return createExecutionProcess(db, { taskId, executorType: 'openclaw' })
}

describe('recordExecutionUsage + completeExecutionProcess', () => {
  it('a close without a cost keeps the cost, source, tokens and runtime the drain recorded', () => {
    const t = createTask(db, { title: 'poem', teamId: 'T' })
    const ex = openRun(t.id)
    expect(ex.costSource).toBeNull()
    expect(ex.runtime).toBeNull()

    const recorded = recordExecutionUsage(db, ex.id, {
      costUsd: 0.25,
      costSource: 'token-estimate',
      inputTokens: 1200,
      outputTokens: 340,
      runtime: 'codex',
    })
    expect(recorded?.status).toBe('running')

    // The engine's close, which carries no cost at all.
    const closed = completeExecutionProcess(db, ex.id, { status: 'succeeded' })
    expect(closed).toMatchObject({
      status: 'succeeded',
      costUsd: 0.25,
      costSource: 'token-estimate',
      inputTokens: 1200,
      outputTokens: 340,
      runtime: 'codex',
      executorType: 'openclaw',
    })
    expect(getTask(db, t.id)!.costUsd).toBeCloseTo(0.25, 10)
  })

  it('records a cost on a row already closed by a Stop, leaving the close itself untouched', () => {
    const t = createTask(db, { title: 'stopped', teamId: 'T' })
    const ex = openRun(t.id)
    completeExecutionProcess(db, ex.id, { status: 'cancelled', error: 'stopped by user' })
    const [before] = listExecutions(db, t.id)

    const after = recordExecutionUsage(db, ex.id, { costUsd: 0.03, costSource: 'reported' })

    expect(after).toMatchObject({ costUsd: 0.03, costSource: 'reported' })
    expect(after?.status).toBe(before!.status)
    expect(after?.completedAt).toBe(before!.completedAt)
    expect(after?.error).toBe(before!.error)
    expect(after?.summary).toBe(before!.summary)
    // Tokens and runtime were not given, so they stay as they were.
    expect(after?.inputTokens).toBeNull()
    expect(after?.runtime).toBeNull()
    expect(getTask(db, t.id)!.costUsd).toBeCloseTo(0.03, 10)
  })

  it("keeps the task's cost the sum of its runs, recomputed rather than added to", () => {
    const t = createTask(db, { title: 'two runs', teamId: 'T' })
    const first = openRun(t.id)
    const second = openRun(t.id)
    recordExecutionUsage(db, first.id, { costUsd: 0.01, costSource: 'reported' })
    recordExecutionUsage(db, second.id, { costUsd: 0.02, costSource: 'reported' })
    expect(getTask(db, t.id)!.costUsd).toBeCloseTo(0.03, 10)

    // Rewriting the first run's cost replaces it in the total.
    recordExecutionUsage(db, first.id, { costUsd: 0.05, costSource: 'reported' })
    expect(getTask(db, t.id)!.costUsd).toBeCloseTo(0.07, 10)
  })

  it('does not bump the task updatedAt when a cost lands', () => {
    const t = createTask(db, { title: 'quiet', teamId: 'T' })
    const ex = openRun(t.id)
    db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, t.id)).run()
    recordExecutionUsage(db, ex.id, { costUsd: 0.01, costSource: 'reported' })
    expect(getTask(db, t.id)!.updatedAt).toBe(1)
  })

  it('returns null for an unknown execution and writes nothing', () => {
    const t = createTask(db, { title: 'none', teamId: 'T' })
    expect(() =>
      recordExecutionUsage(db, 'no-such-exec', { costUsd: 1, costSource: 'reported' }),
    ).not.toThrow()
    expect(
      recordExecutionUsage(db, 'no-such-exec', { costUsd: 1, costSource: 'reported' }),
    ).toBeNull()
    expect(getTask(db, t.id)!.costUsd).toBe(0)
  })
})

describe('completeExecutionProcess with a cost', () => {
  it('stores the source and refreshes the task total', () => {
    const t = createTask(db, { title: 'executor', teamId: 'T' })
    const earlier = openRun(t.id)
    recordExecutionUsage(db, earlier.id, { costUsd: 0.1, costSource: 'char-estimate' })
    const ex = openRun(t.id)

    const closed = completeExecutionProcess(db, ex.id, {
      status: 'succeeded',
      costUsd: 0.4,
      costSource: 'reported',
    })

    expect(closed).toMatchObject({ costUsd: 0.4, costSource: 'reported' })
    expect(getTask(db, t.id)!.costUsd).toBeCloseTo(0.5, 10)
  })

  it('an explicit null that clears a recorded run cost refreshes the task total', () => {
    const t = createTask(db, { title: 'cleared', teamId: 'T' })
    const kept = openRun(t.id)
    recordExecutionUsage(db, kept.id, { costUsd: 0.1, costSource: 'reported' })
    const ex = openRun(t.id)
    recordExecutionUsage(db, ex.id, { costUsd: 0.2, costSource: 'reported' })
    expect(getTask(db, t.id)!.costUsd).toBeCloseTo(0.3, 10)

    const closed = completeExecutionProcess(db, ex.id, {
      status: 'failed',
      costUsd: null,
      costSource: null,
    })

    expect(closed).toMatchObject({ costUsd: null, costSource: null })
    expect(getTask(db, t.id)!.costUsd).toBeCloseTo(0.1, 10)
  })

  it('an explicit null on a run that never had a cost leaves an older task total alone', () => {
    const t = createTask(db, { title: 'from before the ledger', teamId: 'T' })
    db.update(tasks).set({ costUsd: 0.9 }).where(eq(tasks.id, t.id)).run()
    const ex = openRun(t.id)

    completeExecutionProcess(db, ex.id, { status: 'failed', costUsd: null, costSource: null })

    expect(getTask(db, t.id)!.costUsd).toBeCloseTo(0.9, 10)
  })
})

describe('runCostForTasks', () => {
  it('sums each task from its own ledger, keyed by task id', () => {
    const never = createTask(db, { title: 'never ran', teamId: 'T' })
    const tomb = createTask(db, { title: 'tombstone only', teamId: 'T' })
    const mixed = createTask(db, { title: 'mixed', teamId: 'T' })
    const legacy = createTask(db, { title: 'legacy', teamId: 'T' })

    const dead = openRun(tomb.id)
    completeExecutionProcess(db, dead.id, { status: 'failed', error: 'orphaned' })
    db.update(executionProcesses)
      .set({ recoveryTombstone: 1 })
      .where(eq(executionProcesses.id, dead.id))
      .run()

    recordExecutionUsage(db, openRun(mixed.id).id, { costUsd: 0.1, costSource: 'reported' })
    recordExecutionUsage(db, openRun(mixed.id).id, { costUsd: 0.02, costSource: 'token-estimate' })

    // Written before runs carried their own cost: a task total with no costed run.
    db.update(tasks).set({ costUsd: 0.05 }).where(eq(tasks.id, legacy.id)).run()
    openRun(legacy.id)

    const rows = [never, tomb, mixed, legacy].map((t) => getTask(db, t.id)!)
    const costs = runCostForTasks(db, rows)

    expect(costs.get(never.id)).toEqual({ usd: null, estimated: false })
    expect(costs.get(tomb.id)).toEqual({ usd: null, estimated: false })
    expect(costs.get(mixed.id)?.usd).toBeCloseTo(0.12, 10)
    expect(costs.get(mixed.id)?.estimated).toBe(true)
    expect(costs.get(legacy.id)).toEqual({ usd: 0.05, estimated: true })
  })

  it('a reported-only task is not an estimate, and an unknown task has no cost', () => {
    const t = createTask(db, { title: 'reported', teamId: 'T' })
    recordExecutionUsage(db, openRun(t.id).id, { costUsd: 0.42, costSource: 'reported' })
    expect(runCostForTask(db, t.id)).toEqual({ usd: 0.42, estimated: false })
    expect(runCostForTask(db, 'no-such-task')).toBeNull()
  })

  it('reads a board larger than one query chunk', () => {
    const many = Array.from({ length: 501 }, (_, i) => createTask(db, { title: `t${i}` }))
    const last = many[many.length - 1]!
    recordExecutionUsage(db, openRun(last.id).id, { costUsd: 0.01, costSource: 'reported' })
    const costs = runCostForTasks(db, many)
    expect(costs.size).toBe(501)
    expect(costs.get(last.id)).toEqual({ usd: 0.01, estimated: false })
    expect(costs.get(many[0]!.id)).toEqual({ usd: null, estimated: false })
  })
})
