// Priority is four named levels over the integer column, and every write is
// clamped to them. Unclamped, any writer (an agent's create_task included)
// could put its task ahead of everyone else's with a large number.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { tasks } from '../../schema'
import {
  createCappedRootTask,
  createTask,
  getDependencies,
  getReadyTasks,
  getTask,
  linkDep,
  updateStatus,
  updateTaskFields,
} from '../repository'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-task-priority-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('task priority writes', () => {
  it('clamps a create to the four levels', () => {
    expect(createTask(db, { title: 'a', priority: 999_999 }).priority).toBe(2)
    expect(createTask(db, { title: 'b', priority: -40 }).priority).toBe(-1)
    expect(createTask(db, { title: 'c' }).priority).toBe(0)
    const capped = createCappedRootTask(db, { title: 'd', priority: 50 })
    expect(capped.ok && getTask(db, capped.task.id)?.priority).toBe(2)
  })

  it('clamps an update the same way', () => {
    const t = createTask(db, { title: 'a' })
    expect(updateTaskFields(db, t.id, { priority: 7 })?.priority).toBe(2)
    expect(updateTaskFields(db, t.id, { priority: -7 })?.priority).toBe(-1)
    expect(updateTaskFields(db, t.id, { priority: 1 })?.priority).toBe(1)
  })
})

describe('the ready queue', () => {
  it('serves the higher level first, and reads an old unclamped value as its nearest level', () => {
    const normal = createTask(db, { title: 'normal', teamId: 'T' })
    const urgent = createTask(db, { title: 'urgent', teamId: 'T', priority: 2 })
    const legacy = createTask(db, { title: 'legacy', teamId: 'T' })
    // A value written before the clamp existed.
    db.update(tasks).set({ priority: 100, updatedAt: 1 }).where(eq(tasks.id, legacy.id)).run()
    db.update(tasks).set({ updatedAt: 2 }).where(eq(tasks.id, urgent.id)).run()

    const order = getReadyTasks(db, { teamId: 'T' }).map((t) => t.title)
    // `legacy` reads as urgent, not as above urgent, so the newer urgent task
    // comes first within the level.
    expect(order).toEqual(['urgent', 'legacy', 'normal'])
    expect(normal.priority).toBe(0)
  })
})

describe('getDependencies', () => {
  it('lists the tasks one waits on, oldest first, and nothing for a task that waits on none', () => {
    const first = createTask(db, { title: 'outline' })
    const second = createTask(db, { title: 'research' })
    const third = createTask(db, { title: 'draft' })
    // Created in the same millisecond on a fast machine: make the order explicit.
    db.update(tasks).set({ createdAt: 1 }).where(eq(tasks.id, first.id)).run()
    db.update(tasks).set({ createdAt: 2 }).where(eq(tasks.id, second.id)).run()
    linkDep(db, third.id, second.id)
    linkDep(db, third.id, first.id)
    updateStatus(db, first.id, 'in_progress')

    expect(getDependencies(db, third.id).map((t) => t.title)).toEqual(['outline', 'research'])
    expect(getDependencies(db, third.id)[0]?.status).toBe('in_progress')
    expect(getDependencies(db, first.id)).toEqual([])
  })
})
