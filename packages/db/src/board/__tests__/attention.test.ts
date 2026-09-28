import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { encodeHumanAssignment, MAX_AUTO_FIRES } from '@clawboo/board-core'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { tasks } from '../../schema'
import { attentionForTask, attentionForTasks } from '../attention'
import {
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getTask,
  listExecutionsForTasks,
  listTasks,
  rebindTaskDelegation,
  updateStatus,
} from '../repository'

let dir: string
let db: ClawbooDb
let clock = 1_000_000

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-attention-'))
  db = createDb(path.join(dir, 'test.db'))
  // Distinct creation times, so a ledger's order is its run order.
  vi.useFakeTimers({ toFake: ['Date'] })
  clock = 1_000_000
  vi.setSystemTime(clock)
})

afterEach(() => {
  vi.useRealTimers()
  rmSync(dir, { recursive: true, force: true })
})

/** Append one finished run to a task's ledger. */
function run(taskId: string, status: 'succeeded' | 'failed' | 'timed_out' | 'cancelled'): void {
  clock += 10
  vi.setSystemTime(clock)
  const ex = createExecutionProcess(db, { taskId, executorType: 'openclaw' })
  completeExecutionProcess(db, ex.id, { status })
}

const BOUND = 'r1:deleg:agent:a2:reflectTo:leader'

describe('listExecutionsForTasks', () => {
  it('returns every requested ledger oldest first, and [] for a task that never ran', () => {
    const a = createTask(db, { title: 'a', teamId: 'T' })
    const b = createTask(db, { title: 'b', teamId: 'T' })
    run(a.id, 'failed')
    run(a.id, 'succeeded')
    const ledgers = listExecutionsForTasks(db, [a.id, b.id])
    expect(ledgers.get(a.id)?.map((e) => e.status)).toEqual(['failed', 'succeeded'])
    expect(ledgers.get(b.id)).toEqual([])
  })
})

describe('attentionForTasks', () => {
  it('flags a failed run parked on blocked, and leaves healthy work alone', () => {
    const failed = createTask(db, { title: 'failed', teamId: 'T', sourceDelegationId: BOUND })
    claimTask(db, failed.id, 'a2')
    run(failed.id, 'failed')
    updateStatus(db, failed.id, 'blocked')
    const queued = createTask(db, { title: 'queued', teamId: 'T', sourceDelegationId: BOUND })
    const working = createTask(db, { title: 'working', teamId: 'T', sourceDelegationId: BOUND })
    claimTask(db, working.id, 'a2')

    const byId = attentionForTasks(db, listTasks(db, { teamId: 'T' }))
    expect(byId.get(failed.id)).toEqual({ reason: 'failed', failedRuns: 1 })
    expect(byId.get(queued.id)).toBeNull()
    expect(byId.get(working.id)).toBeNull()
  })

  it('flags a todo card no agent will ever pick up', () => {
    const manual = createTask(db, { title: 'manual', teamId: 'T' })
    expect(attentionForTask(db, manual.id)).toEqual({ reason: 'unassigned', failedRuns: 0 })
  })

  it('flags work the user stopped, and work parked after repeated failures', () => {
    const stopped = createTask(db, { title: 'stopped', teamId: 'T', sourceDelegationId: BOUND })
    run(stopped.id, 'cancelled')
    const parked = createTask(db, { title: 'parked', teamId: 'T', sourceDelegationId: BOUND })
    for (let i = 0; i < MAX_AUTO_FIRES; i++) run(parked.id, 'timed_out')

    expect(attentionForTask(db, stopped.id)?.reason).toBe('stopped')
    expect(attentionForTask(db, parked.id)).toEqual({
      reason: 'timed_out',
      failedRuns: MAX_AUTO_FIRES,
    })
  })

  it('reads a blocking verification verdict as needing review', () => {
    const t = createTask(db, { title: 'reviewed', teamId: 'T', sourceDelegationId: BOUND })
    claimTask(db, t.id, 'a2')
    // A failing verdict, as the verification gate stores it.
    db.update(tasks)
      .set({ verification: JSON.stringify({ status: 'fail', attempts: [] }) })
      .where(eq(tasks.id, t.id))
      .run()
    updateStatus(db, t.id, 'blocked')
    expect(attentionForTask(db, t.id)?.reason).toBe('needs_review')
  })

  it('is null for a task that does not exist', () => {
    expect(attentionForTask(db, 'nope')).toBeNull()
  })
})

describe('rebindTaskDelegation', () => {
  it('binds an unassigned card to an agent, which clears its needs-you state', () => {
    const t = createTask(db, { title: 'manual', teamId: 'T' })
    const sdid = encodeHumanAssignment('a2', 'n1')
    expect(rebindTaskDelegation(db, t.id, sdid)?.sourceDelegationId).toBe(sdid)
    expect(attentionForTask(db, t.id)).toBeNull()
  })

  it('refuses while the task is being worked, so a live run keeps its owner', () => {
    const t = createTask(db, { title: 'live', teamId: 'T', sourceDelegationId: BOUND })
    claimTask(db, t.id, 'a2')
    expect(rebindTaskDelegation(db, t.id, encodeHumanAssignment('a3', 'n1'))).toBeNull()
    expect(getTask(db, t.id)?.sourceDelegationId).toBe(BOUND)
  })
})
