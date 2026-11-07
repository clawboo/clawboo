// The order work is served in: tasks that ran before first, then priority, then
// oldest first, with aging so a low-priority task cannot wait forever. The server
// scan and every engine read this one query, so the two stay in step.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { READY_AGING_STEP_MS } from '@clawboo/board-core'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { tasks } from '../../schema'
import {
  completeExecutionProcess,
  createExecutionProcess,
  createTask,
  getReadyTasks,
  updateTaskFields,
} from '../repository'
import { listWaitingTaskWakes, recordTaskWake } from '../../taskWakes'

let dir: string
let db: ClawbooDb

const NOW = 1_800_000_000_000
const HOUR = 3_600_000

/** A task created at a known moment, so no test depends on the clock's grain. */
function taskAt(title: string, createdAt: number, priority = 0): string {
  const t = createTask(db, { title, teamId: 'T', priority })
  db.update(tasks).set({ createdAt, updatedAt: createdAt }).where(eq(tasks.id, t.id)).run()
  return t.id
}

function ended(
  taskId: string,
  status:
    'failed' | 'timed_out' | 'cancelled' | 'budget_held' | 'budget_paused' | 'breaker_tripped',
  errorClass?: string,
): void {
  const exec = createExecutionProcess(db, { taskId, executorType: 'openclaw' })
  completeExecutionProcess(db, exec.id, { status, ...(errorClass ? { errorClass } : {}) })
}

const order = (): string[] => getReadyTasks(db, { teamId: 'T', now: NOW }).map((t) => t.title)

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-fair-order-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('the ready list', () => {
  it('serves equal priority oldest first', () => {
    taskAt('newest', NOW - 1_000)
    taskAt('oldest', NOW - 3_000)
    taskAt('middle', NOW - 2_000)
    expect(order()).toEqual(['oldest', 'middle', 'newest'])
  })

  it('does not move a task forward because someone edited it', () => {
    const newest = taskAt('newest', NOW - 1_000)
    taskAt('oldest', NOW - 2_000)
    updateTaskFields(db, newest, { title: 'newest, edited' })
    expect(order()).toEqual(['oldest', 'newest, edited'])
  })

  it('still serves the higher level first among fresh work', () => {
    taskAt('low', NOW - 4_000, -1)
    taskAt('normal', NOW - 3_000, 0)
    taskAt('high', NOW - 2_000, 1)
    taskAt('urgent', NOW - 1_000, 2)
    expect(order()).toEqual(['urgent', 'high', 'normal', 'low'])
  })

  it('serves a task released after a crash ahead of fresh work of any priority', () => {
    taskAt('fresh urgent', NOW - 2_000, 2)
    const released = taskAt('released low', NOW - 1_000, -1)
    ended(released, 'timed_out')
    expect(order()).toEqual(['released low', 'fresh urgent'])
  })

  it('orders tasks that ran before among themselves by priority, then age', () => {
    const a = taskAt('ran, normal, newer', NOW - 1_000)
    const b = taskAt('ran, normal, older', NOW - 2_000)
    const c = taskAt('ran, urgent', NOW - 500, 2)
    for (const id of [a, b, c]) ended(id, 'failed')
    expect(order()).toEqual(['ran, urgent', 'ran, normal, older', 'ran, normal, newer'])
  })

  it('does not count a run a person stopped as work to carry on first', () => {
    taskAt('older', NOW - 2_000)
    const stopped = taskAt('stopped by a person', NOW - 1_000)
    ended(stopped, 'cancelled')
    expect(order()).toEqual(['older', 'stopped by a person'])
  })

  it('does not count a start a budget refused as work to carry on first', () => {
    const held = taskAt('budget held', NOW - 100)
    ended(held, 'budget_held')
    const capped = taskAt('budget capped', NOW - 200)
    ended(capped, 'budget_paused')
    taskAt('older fresh work', NOW - 3_000)
    expect(order()[0]).toBe('older fresh work')
  })

  it('counts a run the breaker stopped as work that came back', () => {
    const broke = taskAt('broke', NOW - 100)
    ended(broke, 'breaker_tripped')
    taskAt('older fresh work', NOW - 3_000)
    expect(order()[0]).toBe('broke')
  })

  it('counts a run a pause stopped as work to carry on first', () => {
    taskAt('older', NOW - 2_000)
    const stopped = taskAt('stopped by a pause', NOW - 1_000)
    ended(stopped, 'cancelled', 'Paused')
    expect(order()).toEqual(['stopped by a pause', 'older'])
  })

  it('ages a waiting low-priority task past fresher work, one level per step', () => {
    taskAt('fresh normal', NOW - 1_000, 0)
    // One step old: reads as normal, and the older of the two.
    taskAt('aged low', NOW - READY_AGING_STEP_MS, -1)
    expect(order()).toEqual(['aged low', 'fresh normal'])
  })

  it('lets a low-priority task through a steady stream of high and normal work in the end', () => {
    // Two steps take low (-1) to high (1), and then it is simply the oldest there.
    taskAt('waiting low', NOW - 2 * READY_AGING_STEP_MS, -1)
    taskAt('fresh high', NOW - 2_000, 1)
    taskAt('fresh normal', NOW - 1_000, 0)
    expect(order()).toEqual(['waiting low', 'fresh high', 'fresh normal'])
  })

  it('keeps a fresh Urgent ahead of overnight work: aging never reads as Urgent', () => {
    taskAt('overnight normal', NOW - 16 * HOUR, 0)
    taskAt('parked low, ready now', NOW - 100 * HOUR, -1)
    taskAt('old high', NOW - 40 * HOUR, 1)
    taskAt('fresh urgent', NOW - 1_000, 2)
    expect(order()[0]).toBe('fresh urgent')
    expect(order().slice(1)).toEqual(['parked low, ready now', 'old high', 'overnight normal'])
  })

  it('keeps an urgent task ahead of a backlog that has only waited a few hours', () => {
    taskAt('backlog', NOW - HOUR, 0)
    taskAt('fresh urgent', NOW - 1_000, 2)
    expect(order()).toEqual(['fresh urgent', 'backlog'])
  })

  it('reads an old unclamped priority as its nearest level, so it cannot jump the queue', () => {
    const legacy = taskAt('legacy', NOW - 1_000)
    taskAt('older urgent', NOW - 2_000, 2)
    db.update(tasks).set({ priority: 100 }).where(eq(tasks.id, legacy)).run()
    expect(order()).toEqual(['older urgent', 'legacy'])
  })

  it('reads a creation time in the future as no age at all', () => {
    taskAt('clock ran ahead', NOW + 10 * READY_AGING_STEP_MS, -1)
    taskAt('normal', NOW - 1_000, 0)
    expect(order()).toEqual(['normal', 'clock ran ahead'])
  })
})

describe('the wake list', () => {
  it('waits in the same order as the ready list, whichever wake came first', () => {
    const at = Date.now()
    const ids = [
      taskAt('ancient low', at - 24 * HOUR, -1),
      taskAt('new normal', at - 1_000, 0),
      taskAt('new urgent', at - 500, 2),
      taskAt('old normal', at - HOUR, 0),
      taskAt('ran before', at - 100, -1),
    ]
    ended(ids[4]!, 'failed')
    // The newest task's wake first, so oldest-first would read them backwards.
    for (const taskId of [...ids].reverse()) {
      recordTaskWake(db, { teamId: 'T', agentId: 'a1', taskId, reason: 'person_comment' })
    }

    const titles = new Map(getReadyTasks(db, { teamId: 'T' }).map((t) => [t.id, t.title]))
    expect(listWaitingTaskWakes(db).map((w) => titles.get(w.taskId))).toEqual(
      getReadyTasks(db, { teamId: 'T' }).map((t) => t.title),
    )
    expect([...titles.values()].slice(0, 2)).toEqual(['ran before', 'new urgent'])
  })
})
