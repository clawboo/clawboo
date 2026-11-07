import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { teams } from '../../schema'
import {
  MAX_LABELS_PER_TASK,
  createLabel,
  deleteLabel,
  labelsForTasks,
  listLabels,
  renameLabel,
  setTaskLabels,
} from '../labels'
import { createTask } from '../repository'

let dir: string
let db: ClawbooDb

function addTeam(id: string): void {
  db.insert(teams)
    .values({ id, name: id, icon: 'x', color: '#0', createdAt: 1, updatedAt: 1 })
    .run()
}

function label(teamId: string, name: string): string {
  const r = createLabel(db, teamId, name)
  if (!r.ok) throw new Error(r.reason)
  return r.label.id
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-labels-'))
  db = createDb(path.join(dir, 'test.db'))
  addTeam('t1')
  addTeam('t2')
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('labels', () => {
  it('belong to one team, and a name is unique in it whatever its case', () => {
    expect(createLabel(db, 't1', ' Bug ').ok).toBe(true)
    expect(createLabel(db, 't1', 'bug')).toEqual({ ok: false, reason: 'taken' })
    expect(createLabel(db, 't2', 'bug').ok).toBe(true)
    expect(listLabels(db, 't1').map((l) => l.name)).toEqual(['Bug'])
  })

  it('refuse an empty or long name, and a team that is not there', () => {
    expect(createLabel(db, 't1', '   ')).toEqual({ ok: false, reason: 'invalid' })
    expect(createLabel(db, 't1', 'x'.repeat(41))).toEqual({ ok: false, reason: 'invalid' })
    expect(createLabel(db, 'ghost', 'bug')).toEqual({ ok: false, reason: 'not_found' })
  })

  it('rename within the same rules', () => {
    const bug = label('t1', 'bug')
    label('t1', 'idea')
    expect(renameLabel(db, 't1', bug, 'idea')).toEqual({ ok: false, reason: 'taken' })
    expect(renameLabel(db, 't2', bug, 'x')).toEqual({ ok: false, reason: 'not_found' })
    const r = renameLabel(db, 't1', bug, 'Defect')
    expect(r.ok && r.label.name).toBe('Defect')
    expect(renameLabel(db, 't1', bug, 'DEFECT').ok).toBe(true)
  })
})

describe('labels on a task', () => {
  it('replaces the set, and reads back in one query per board', () => {
    const a = label('t1', 'a')
    const b = label('t1', 'b')
    const t1 = createTask(db, { title: 'x', teamId: 't1' })
    const t2 = createTask(db, { title: 'y', teamId: 't1' })
    expect(setTaskLabels(db, t1.id, [a, b]).ok).toBe(true)
    expect(setTaskLabels(db, t2.id, [b]).ok).toBe(true)
    expect(setTaskLabels(db, t1.id, [b]).ok).toBe(true)
    const byTask = labelsForTasks(db, [t1.id, t2.id])
    expect(byTask.get(t1.id)?.map((l) => l.name)).toEqual(['b'])
    expect(byTask.get(t2.id)?.map((l) => l.name)).toEqual(['b'])
  })

  it("refuses another team's label, changing nothing", () => {
    const mine = label('t1', 'mine')
    const theirs = label('t2', 'theirs')
    const t = createTask(db, { title: 'x', teamId: 't1' })
    setTaskLabels(db, t.id, [mine])
    expect(setTaskLabels(db, t.id, [theirs])).toEqual({ ok: false, reason: 'label_not_in_team' })
    expect(
      labelsForTasks(db, [t.id])
        .get(t.id)
        ?.map((l) => l.name),
    ).toEqual(['mine'])
  })

  it('refuses a task with no team and a task that is not there', () => {
    const a = label('t1', 'a')
    const loose = createTask(db, { title: 'x' })
    expect(setTaskLabels(db, loose.id, [a])).toEqual({ ok: false, reason: 'label_not_in_team' })
    expect(setTaskLabels(db, loose.id, [])).toEqual({ ok: true, labels: [] })
    expect(setTaskLabels(db, 'ghost', [])).toEqual({ ok: false, reason: 'not_found' })
  })

  it('caps how many one task can carry', () => {
    const ids = Array.from({ length: MAX_LABELS_PER_TASK + 1 }, (_, i) => label('t1', `l${i}`))
    const t = createTask(db, { title: 'x', teamId: 't1' })
    expect(setTaskLabels(db, t.id, ids)).toEqual({ ok: false, reason: 'too_many' })
  })

  it('deleting a label takes it off every task', () => {
    const a = label('t1', 'a')
    const t = createTask(db, { title: 'x', teamId: 't1' })
    setTaskLabels(db, t.id, [a])
    expect(deleteLabel(db, 't2', a)).toBe(false)
    expect(deleteLabel(db, 't1', a)).toBe(true)
    expect(labelsForTasks(db, [t.id]).get(t.id) ?? []).toEqual([])
  })

  it('deleting a team takes its labels with it', () => {
    label('t1', 'a')
    db.delete(teams).where(eq(teams.id, 't1')).run()
    expect(listLabels(db, 't1')).toEqual([])
  })
})
