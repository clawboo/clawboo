// The run's person: one answer, in the order the per-run credentials design and the
// owner's D1 and D7 give, and the run references a tool looks it up by.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createTask } from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

const { getDb, getDbPath, resetDb } = await import('../db')
const { openRunRef, resetRunRefsForTests, runPersonForRef, runPersonOf } =
  await import('../runPerson')

const ADA = { id: 'user-ada', name: 'Ada', role: 'member' }
const BOB = { id: 'user-bob', name: 'Bob', role: null }

let home: string
const prev: Record<string, string | undefined> = {}

beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-run-person-'))
  await mkdir(path.join(home, '.clawboo'), { recursive: true })
  for (const name of ['HOME', 'CLAWBOO_HOME']) {
    prev[name] = process.env[name]
    process.env[name] = home
  }
  expect(getDbPath().startsWith(home)).toBe(true)
})

afterEach(async () => {
  resetRunRefsForTests()
  resetDb()
  for (const [name, value] of Object.entries(prev)) {
    if (value === undefined) delete process.env[name]
    else process.env[name] = value
  }
  await rm(home, { recursive: true, force: true })
})

describe('runPersonOf', () => {
  it('is the person who started the run first, over the task requester (a Retry is the retrier s)', () => {
    const t = createTask(getDb(), { title: 'x', requestedBy: ADA })
    expect(runPersonOf({ db: getDb(), startedBy: BOB, taskId: t.id })).toEqual({
      person: BOB,
      basis: 'started',
    })
  })

  it('is the requester of the task, or of its nearest ancestor that names one', () => {
    const db = getDb()
    const parent = createTask(db, { title: 'asked', requestedBy: ADA })
    const child = createTask(db, { title: 'helper', parentTaskId: parent.id })
    const grandchild = createTask(db, { title: 'helper of helper', parentTaskId: child.id })
    expect(runPersonOf({ db, taskId: grandchild.id })).toEqual({
      person: ADA,
      basis: 'task_requester',
    })
  })

  it('names no one when nothing names anyone: no fallback to the local person', () => {
    const t = createTask(getDb(), { title: 'an agent made this on its own' })
    expect(runPersonOf({ db: getDb(), taskId: t.id })).toEqual({ person: null, basis: 'none' })
    // A turn that failed the person check: no one started it and it has no task.
    expect(runPersonOf({ db: getDb(), startedBy: null })).toEqual({ person: null, basis: 'none' })
  })

  it("the dashboard's own person, passed as the one who started it, is that person", () => {
    const local = { id: 'local', name: 'You', role: null }
    expect(runPersonOf({ startedBy: local })).toEqual({ person: local, basis: 'started' })
  })

  it("a team routine's request, and the work handed out under it, belongs to no one", () => {
    const db = getDb()
    // A routine's message makes a main task that names no requester.
    const main = createTask(db, { title: 'nightly digest' })
    const handOff = createTask(db, { title: 'gather', parentTaskId: main.id })
    expect(runPersonOf({ db, taskId: handOff.id })).toEqual({ person: null, basis: 'none' })
  })

  it("a routine's fire belongs to no one", () => {
    expect(runPersonOf({ routine: { createdBy: null, runAsCreator: false } })).toEqual({
      person: null,
      basis: 'none',
    })
    // Even a creator, unless the routine runs as its creator.
    expect(runPersonOf({ routine: { createdBy: ADA, runAsCreator: false } })).toEqual({
      person: null,
      basis: 'none',
    })
    expect(runPersonOf({ routine: { createdBy: ADA, runAsCreator: true } })).toEqual({
      person: ADA,
      basis: 'routine_creator',
    })
  })

  it('the work a routine fired belongs to no one, even under a task a person asked for', () => {
    const db = getDb()
    const fired = createTask(db, { title: 'nightly', scheduledBy: 'routine-1', requestedBy: ADA })
    const helper = createTask(db, { title: 'step', parentTaskId: fired.id })
    expect(runPersonOf({ db, taskId: helper.id })).toEqual({
      person: null,
      basis: 'none',
    })
  })
})

describe('run references', () => {
  it('answer for their own agent while the run lives, and never after', () => {
    const run = openRunRef('coder', { person: ADA, basis: 'started' })
    expect(runPersonForRef(run.ref, 'coder')).toEqual({ person: ADA, basis: 'started' })
    expect(runPersonForRef(run.ref, 'another-agent')).toBeNull()
    run.release()
    expect(runPersonForRef(run.ref, 'coder')).toBeNull()
    expect(runPersonForRef('made-up', 'coder')).toBeNull()
    expect(runPersonForRef(null, 'coder')).toBeNull()
  })

  it('are random and unrelated to the person', () => {
    const a = openRunRef('coder', { person: ADA, basis: 'started' })
    const b = openRunRef('coder', { person: ADA, basis: 'started' })
    expect(a.ref).not.toBe(b.ref)
    expect(a.ref).toMatch(/^[A-Za-z0-9_-]{22}$/)
    expect(a.ref).not.toContain(ADA.id)
  })

  it('keep a copy, so a caller changing its object later changes nothing', () => {
    const person = { ...ADA }
    const run = openRunRef('coder', { person, basis: 'started' })
    person.id = 'user-mallory'
    expect(runPersonForRef(run.ref, 'coder')?.person?.id).toBe(ADA.id)
  })
})
