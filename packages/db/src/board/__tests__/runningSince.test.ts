// The board's run clock reads when each task's live run started. These tests pin
// which run counts: only running rows, the newest of several, and only the tasks
// asked about.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { executionProcesses } from '../../schema'
import { completeExecutionProcess, createExecutionProcess, createTask } from '../repository'
import { runningSinceForTasks } from '../runningSince'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-runningsince-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

/** Opens a running run for the task, started at `startedAt`. */
function openRun(taskId: string, startedAt: number) {
  const ex = createExecutionProcess(db, { taskId, executorType: 'openclaw' })
  db.update(executionProcesses).set({ startedAt }).where(eq(executionProcesses.id, ex.id)).run()
  return ex
}

describe('runningSinceForTasks', () => {
  it("returns a running run's start time", () => {
    const t = createTask(db, { title: 'live', teamId: 'T' })
    openRun(t.id, 1_000)
    expect(runningSinceForTasks(db, [t.id]).get(t.id)).toBe(1_000)
  })

  it('ignores a run that has completed', () => {
    const t = createTask(db, { title: 'finished', teamId: 'T' })
    const ex = openRun(t.id, 1_000)
    completeExecutionProcess(db, ex.id, { status: 'succeeded' })
    expect(runningSinceForTasks(db, [t.id]).has(t.id)).toBe(false)
  })

  it('of two running runs, the newer start wins', () => {
    const t = createTask(db, { title: 'two runs', teamId: 'T' })
    openRun(t.id, 5_000)
    openRun(t.id, 2_000)
    expect(runningSinceForTasks(db, [t.id]).get(t.id)).toBe(5_000)
  })

  it('leaves out a task with no runs', () => {
    const t = createTask(db, { title: 'never ran', teamId: 'T' })
    const since = runningSinceForTasks(db, [t.id])
    expect(since.has(t.id)).toBe(false)
    expect(since.size).toBe(0)
  })

  it('returns only the tasks asked about', () => {
    const asked = createTask(db, { title: 'asked', teamId: 'T' })
    const other = createTask(db, { title: 'other', teamId: 'T' })
    openRun(asked.id, 1_000)
    openRun(other.id, 2_000)
    const since = runningSinceForTasks(db, [asked.id])
    expect(since.get(asked.id)).toBe(1_000)
    expect(since.has(other.id)).toBe(false)
    expect(since.size).toBe(1)
  })

  it('an empty id list returns an empty map', () => {
    const t = createTask(db, { title: 'live', teamId: 'T' })
    openRun(t.id, 1_000)
    expect(runningSinceForTasks(db, []).size).toBe(0)
  })
})
