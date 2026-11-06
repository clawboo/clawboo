// Readable task ids: a per-team prefix and counter, unique across the workspace.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { tasks, teams } from '../../schema'
import {
  backfillTaskIdentifiers,
  readTeamTaskPrefix,
  resolveTaskRef,
  setTeamTaskPrefix,
} from '../identifiers'
import { createCappedRootTask, createCappedSubtask, createTask, getTask } from '../repository'

let dir: string
let dbPath: string
let db: ClawbooDb

function addTeam(id: string, name: string, conn: ClawbooDb = db): void {
  conn
    .insert(teams)
    .values({ id, name, icon: 'x', color: '#000', createdAt: 1, updatedAt: 1 })
    .run()
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-identifiers-'))
  dbPath = path.join(dir, 'test.db')
  db = createDb(dbPath)
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('allocation', () => {
  it("numbers a team's tasks under letters from its name", () => {
    addTeam('t1', 'Clawboo')
    expect(createTask(db, { title: 'a', teamId: 't1' }).identifier).toBe('CLA-1')
    expect(createTask(db, { title: 'b', teamId: 't1' }).identifier).toBe('CLA-2')
  })

  it('gives a clash the next free set, and numbers each team apart', () => {
    addTeam('t1', 'Marketing')
    addTeam('t2', 'Marathon')
    addTeam('t3', 'Margins')
    expect(createTask(db, { title: 'a', teamId: 't1' }).identifier).toBe('MAR-1')
    expect(createTask(db, { title: 'b', teamId: 't2' }).identifier).toBe('MA2-1')
    expect(createTask(db, { title: 'c', teamId: 't3' }).identifier).toBe('MA3-1')
    expect(createTask(db, { title: 'd', teamId: 't1' }).identifier).toBe('MAR-2')
  })

  it('numbers every create path from the one counter', () => {
    addTeam('t1', 'Clawboo')
    const root = createCappedRootTask(db, { title: 'root', teamId: 't1' })
    expect(root.ok && root.task.identifier).toBe('CLA-1')
    const child = createCappedSubtask(db, root.ok ? root.task.id : '', { title: 'child' })
    expect(child.ok && child.task.identifier).toBe('CLA-2')
    expect(createTask(db, { title: 'plain', teamId: 't1' }).identifier).toBe('CLA-3')
  })

  it('a task with no team, or a team nobody knows, has no readable id', () => {
    expect(createTask(db, { title: 'loose' }).identifier).toBeNull()
    expect(createTask(db, { title: 'soft ref', teamId: 'ghost' }).identifier).toBeNull()
  })

  it('a team rename changes no ids, and the prefix stays', () => {
    addTeam('t1', 'Clawboo')
    const first = createTask(db, { title: 'a', teamId: 't1' })
    db.update(teams).set({ name: 'Zebra Crew' }).where(eq(teams.id, 't1')).run()
    expect(getTask(db, first.id)?.identifier).toBe('CLA-1')
    expect(createTask(db, { title: 'b', teamId: 't1' }).identifier).toBe('CLA-2')
  })

  it("never reissues the id of a deleted team's task", () => {
    addTeam('t1', 'Marketing')
    const old = createTask(db, { title: 'a', teamId: 't1' })
    db.delete(teams).where(eq(teams.id, 't1')).run()
    addTeam('t2', 'Marathon')
    const next = createTask(db, { title: 'b', teamId: 't2' })
    expect(next.identifier).toBe('MA2-1')
    expect(getTask(db, old.id)?.identifier).toBe('MAR-1')
  })

  it('steps over a number already used, instead of failing every create', () => {
    addTeam('t1', 'Clawboo')
    createTask(db, { title: 'a', teamId: 't1' })
    db.update(teams).set({ nextTaskNumber: 1 }).where(eq(teams.id, 't1')).run()
    expect(createTask(db, { title: 'b', teamId: 't1' }).identifier).toBe('CLA-2')
  })

  it('two connections writing in turn never share an identifier', () => {
    addTeam('t1', 'Clawboo')
    const other = createDb(dbPath)
    try {
      const ids: Array<string | null> = []
      for (let i = 0; i < 10; i += 1) {
        ids.push(createTask(i % 2 ? other : db, { title: `t${i}`, teamId: 't1' }).identifier)
      }
      expect(new Set(ids).size).toBe(10)
      expect(ids).toContain('CLA-10')
    } finally {
      other.$client.close()
    }
  })
})

describe('changing the prefix', () => {
  it("a person can set it before the team's first task, and that is the one used", () => {
    addTeam('t1', 'Clawboo')
    expect(readTeamTaskPrefix(db, 't1')).toEqual({ prefix: null, suggested: 'CLA', locked: false })
    expect(setTeamTaskPrefix(db, 't1', ' clb ')).toEqual({ ok: true, prefix: 'CLB' })
    expect(readTeamTaskPrefix(db, 't1')).toEqual({ prefix: 'CLB', suggested: 'CLB', locked: false })
    expect(createTask(db, { title: 'a', teamId: 't1' }).identifier).toBe('CLB-1')
  })

  it('cannot change once the team has a task', () => {
    addTeam('t1', 'Clawboo')
    createTask(db, { title: 'a', teamId: 't1' })
    expect(readTeamTaskPrefix(db, 't1')?.locked).toBe(true)
    expect(setTeamTaskPrefix(db, 't1', 'NEW')).toEqual({ ok: false, reason: 'locked' })
    expect(createTask(db, { title: 'b', teamId: 't1' }).identifier).toBe('CLA-2')
  })

  it("refuses a prefix another team holds, or one a deleted team's tasks still use", () => {
    addTeam('t1', 'Marketing')
    addTeam('t2', 'Sales')
    createTask(db, { title: 'a', teamId: 't1' })
    expect(setTeamTaskPrefix(db, 't2', 'MAR')).toEqual({ ok: false, reason: 'taken' })
    db.delete(teams).where(eq(teams.id, 't1')).run()
    expect(setTeamTaskPrefix(db, 't2', 'mar')).toEqual({ ok: false, reason: 'taken' })
  })

  it('refuses a shape an id cannot carry, and a team that is not there', () => {
    addTeam('t1', 'Clawboo')
    expect(setTeamTaskPrefix(db, 't1', 'A')).toEqual({ ok: false, reason: 'invalid' })
    expect(setTeamTaskPrefix(db, 't1', '1AB')).toEqual({ ok: false, reason: 'invalid' })
    expect(setTeamTaskPrefix(db, 'ghost', 'ABC')).toEqual({ ok: false, reason: 'not_found' })
    expect(readTeamTaskPrefix(db, 'ghost')).toBeNull()
  })

  it('the suggestion skips what is taken and reserves nothing', () => {
    addTeam('t1', 'Marketing')
    addTeam('t2', 'Marathon')
    createTask(db, { title: 'a', teamId: 't1' })
    expect(readTeamTaskPrefix(db, 't2')?.suggested).toBe('MA2')
    expect(readTeamTaskPrefix(db, 't2')?.prefix).toBeNull()
  })
})

describe('the backfill', () => {
  const rawTask = (id: string, teamId: string | null, createdAt: number): void => {
    db.insert(tasks).values({ id, title: id, teamId, createdAt, updatedAt: createdAt }).run()
  }

  it('numbers old tasks by age, is idempotent, and later creates carry on', () => {
    addTeam('t1', 'Clawboo')
    rawTask('newer', 't1', 200)
    rawTask('older', 't1', 100)
    expect(backfillTaskIdentifiers(db)).toBe(2)
    expect(getTask(db, 'older')?.identifier).toBe('CLA-1')
    expect(getTask(db, 'newer')?.identifier).toBe('CLA-2')
    // A second boot changes nothing.
    expect(backfillTaskIdentifiers(db)).toBe(0)
    expect(getTask(db, 'older')?.identifier).toBe('CLA-1')
    expect(createTask(db, { title: 'c', teamId: 't1' }).identifier).toBe('CLA-3')
  })

  it('does not touch updatedAt, which orders the board', () => {
    addTeam('t1', 'Clawboo')
    rawTask('a', 't1', 100)
    backfillTaskIdentifiers(db)
    expect(getTask(db, 'a')?.updatedAt).toBe(100)
  })

  it('gives older teams the first pick, and leaves empty teams unprefixed', () => {
    db.insert(teams)
      .values([
        { id: 'late', name: 'Marathon', icon: 'x', color: '#0', createdAt: 9, updatedAt: 9 },
        { id: 'early', name: 'Marketing', icon: 'x', color: '#0', createdAt: 1, updatedAt: 1 },
        { id: 'empty', name: 'Sales', icon: 'x', color: '#0', createdAt: 5, updatedAt: 5 },
      ])
      .run()
    rawTask('a', 'late', 100)
    rawTask('b', 'early', 200)
    backfillTaskIdentifiers(db)
    expect(getTask(db, 'b')?.identifier).toBe('MAR-1')
    expect(getTask(db, 'a')?.identifier).toBe('MA2-1')
    expect(readTeamTaskPrefix(db, 'empty')?.prefix).toBeNull()
  })

  it('leaves a task with no team, or whose team is gone, alone', () => {
    rawTask('loose', null, 100)
    rawTask('orphan', 'gone', 100)
    expect(backfillTaskIdentifiers(db)).toBe(0)
    expect(getTask(db, 'orphan')?.identifier).toBeNull()
  })

  it('counts dropped tasks too, so their numbers stay theirs', () => {
    addTeam('t1', 'Clawboo')
    rawTask('gone', 't1', 100)
    db.update(tasks).set({ dropped: 1 }).where(eq(tasks.id, 'gone')).run()
    backfillTaskIdentifiers(db)
    expect(getTask(db, 'gone')?.identifier).toBe('CLA-1')
    expect(readTeamTaskPrefix(db, 't1')?.locked).toBe(true)
  })
})

describe('an upgraded database', () => {
  it('gains the columns and indexes, then numbers its old tasks', () => {
    const file = path.join(dir, 'old.db')
    const old = new Database(file)
    old.exec(`
      CREATE TABLE teams (id TEXT PRIMARY KEY, name TEXT NOT NULL, icon TEXT NOT NULL, color TEXT NOT NULL,
        color_collection_id TEXT, template_id TEXT, leader_agent_id TEXT, is_archived INTEGER NOT NULL DEFAULT 0,
        tenant_id TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE tasks (id TEXT PRIMARY KEY, title TEXT NOT NULL, description TEXT, status TEXT NOT NULL DEFAULT 'backlog',
        priority INTEGER NOT NULL DEFAULT 0, team_id TEXT, assignee_agent_id TEXT, assignee_runtime TEXT,
        parent_task_id TEXT REFERENCES tasks(id), source_delegation_id TEXT, worktree_ref TEXT, branch_ref TEXT,
        cost_usd REAL NOT NULL DEFAULT 0, parent_session_id TEXT, dropped INTEGER NOT NULL DEFAULT 0, tenant_id TEXT,
        verification TEXT, scheduled_by TEXT NOT NULL DEFAULT 'manual', created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL, completed_at INTEGER, room_id TEXT, person_moved_at INTEGER, runner_inputs TEXT);
      INSERT INTO teams (id, name, icon, color, created_at, updated_at) VALUES ('t1', 'Clawboo', 'x', '#0', 1, 1);
      INSERT INTO tasks (id, title, team_id, created_at, updated_at) VALUES ('a', 'a', 't1', 1, 1), ('b', 'b', 't1', 2, 2);
    `)
    old.close()
    const upgraded = createDb(file)
    try {
      expect(backfillTaskIdentifiers(upgraded)).toBe(2)
      expect(getTask(upgraded, 'b')?.identifier).toBe('CLA-2')
      expect(createTask(upgraded, { title: 'c', teamId: 't1' }).identifier).toBe('CLA-3')
      const names = (
        upgraded.$client
          .prepare("SELECT name FROM sqlite_master WHERE type = 'index'")
          .all() as Array<{ name: string }>
      ).map((r) => r.name)
      expect(names).toEqual(
        expect.arrayContaining(['idx_teams_task_prefix', 'idx_tasks_identifier']),
      )
    } finally {
      upgraded.$client.close()
    }
  })
})

describe('resolveTaskRef', () => {
  it('takes the id or the identifier, in either case', () => {
    addTeam('t1', 'Clawboo')
    const t = createTask(db, { title: 'a', teamId: 't1' })
    expect(resolveTaskRef(db, t.id)).toBe(t.id)
    expect(resolveTaskRef(db, 'CLA-1')).toBe(t.id)
    expect(resolveTaskRef(db, 'cla-1')).toBe(t.id)
    expect(resolveTaskRef(db, 'CLA-99')).toBeNull()
    expect(resolveTaskRef(db, 'nonsense')).toBeNull()
  })

  it("scoped to a team, another team's identifier does not resolve", () => {
    addTeam('t1', 'Clawboo')
    addTeam('t2', 'Sales')
    createTask(db, { title: 'a', teamId: 't1' })
    expect(resolveTaskRef(db, 'CLA-1', { teamId: 't2' })).toBeNull()
    expect(resolveTaskRef(db, 'CLA-1', { teamId: 't1' })).not.toBeNull()
  })
})
