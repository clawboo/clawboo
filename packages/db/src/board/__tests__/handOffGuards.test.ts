// The child slot a person's cancel frees, the hand-off chain the cycle guard
// reads, and the failure breaker that survives a restart.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { teams } from '../../schema'
import {
  DELEGATION_FAILURE_WINDOW_MS,
  clearDelegationFailure,
  clearTeamDelegationFailures,
  markDelegationFailureNotified,
  noteDelegationFailure,
  readDelegationFailure,
} from '../delegationFailures'
import {
  cancelDependents,
  createCappedRootTask,
  createCappedSubtask,
  createTask,
  handOffCapacity,
  handOffChain,
  isTeamLeadAgent,
  linkDep,
  setTaskDelegator,
  updateStatus,
} from '../repository'

let dir: string
let dbPath: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-handoff-guards-'))
  dbPath = path.join(dir, 'test.db')
  db = createDb(dbPath)
})

afterEach(() => {
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('child slots', () => {
  const fill = (parentId: string, n: number): string[] =>
    Array.from({ length: n }, (_, i) => {
      const r = createCappedSubtask(db, parentId, { title: `c${i}` }, { maxChildren: n })
      if (!r.ok) throw new Error(r.reason)
      return r.task.id
    })

  it("an agent's cancel frees no slot, so it cannot cancel children and create more", () => {
    const parent = createTask(db, { title: 'p' })
    const [first] = fill(parent.id, 2)
    expect(updateStatus(db, first!, 'cancelled', { unlessPersonMoved: true }).ok).toBe(true)
    const r = createCappedSubtask(db, parent.id, { title: 'more' }, { maxChildren: 2 })
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toBe('child_cap')
  })

  it("a person's cancel frees the slot", () => {
    const parent = createTask(db, { title: 'p' })
    const [first] = fill(parent.id, 2)
    expect(updateStatus(db, first!, 'cancelled', { actor: 'person' }).ok).toBe(true)
    expect(createCappedSubtask(db, parent.id, { title: 'more' }, { maxChildren: 2 }).ok).toBe(true)
  })

  it('a finished child keeps its slot, whoever finished it', () => {
    const parent = createTask(db, { title: 'p' })
    const [first] = fill(parent.id, 2)
    updateStatus(db, first!, 'in_progress')
    expect(updateStatus(db, first!, 'done', { actor: 'person' }).ok).toBe(true)
    expect(createCappedSubtask(db, parent.id, { title: 'more' }, { maxChildren: 2 }).ok).toBe(false)
  })

  it("a person's cancel of a child an agent already cancelled frees the slot", () => {
    const parent = createTask(db, { title: 'p' })
    const [first] = fill(parent.id, 2)
    updateStatus(db, first!, 'cancelled', { unlessPersonMoved: true })
    expect(updateStatus(db, first!, 'cancelled', { actor: 'person' }).ok).toBe(true)
    expect(createCappedSubtask(db, parent.id, { title: 'more' }, { maxChildren: 2 }).ok).toBe(true)
  })

  it("the steps a person's cancel takes with it free their slots too", () => {
    const parent = createTask(db, { title: 'p' })
    const [first, second] = fill(parent.id, 2)
    linkDep(db, second!, first!)
    updateStatus(db, first!, 'cancelled', { actor: 'person' })
    cancelDependents(db, first!, { byPerson: true })
    const r1 = createCappedSubtask(db, parent.id, { title: 'x' }, { maxChildren: 2 })
    const r2 = createCappedSubtask(db, parent.id, { title: 'y' }, { maxChildren: 2 })
    expect(r1.ok && r2.ok).toBe(true)
  })

  it("the steps an agent's cancel takes with it free nothing", () => {
    const parent = createTask(db, { title: 'p' })
    const [first, second] = fill(parent.id, 2)
    linkDep(db, second!, first!)
    updateStatus(db, first!, 'cancelled')
    cancelDependents(db, first!)
    expect(createCappedSubtask(db, parent.id, { title: 'x' }, { maxChildren: 2 }).ok).toBe(false)
  })
})

describe('handOffCapacity', () => {
  it('says how many tasks a parent can still take', () => {
    const parent = createTask(db, { title: 'p' })
    expect(handOffCapacity(db, parent.id)).toEqual({ room: 24, max: 24, reason: 'child_cap' })
    createCappedSubtask(db, parent.id, { title: 'c' })
    expect(handOffCapacity(db, parent.id)?.room).toBe(23)
  })

  it('says how many root tasks fit the rate cap', () => {
    createTask(db, { title: 'r' })
    expect(handOffCapacity(db, null)).toEqual({ room: 29, max: 30, reason: 'root_rate_cap' })
  })
})

describe('the root rate cap, by team', () => {
  it("counts only the team's own roots when asked, every team's when not", () => {
    createTask(db, { title: 'theirs', teamId: 'other' })
    createTask(db, { title: 'theirs too', teamId: 'other' })
    const caps = { maxRootCreates: 2 }
    expect(createCappedRootTask(db, { title: 'x', teamId: 'mine' }, caps).ok).toBe(false)
    expect(
      createCappedRootTask(db, { title: 'x', teamId: 'mine' }, { ...caps, teamId: 'mine' }).ok,
    ).toBe(true)
    expect(handOffCapacity(db, null, 'mine')?.room).toBe(29)
    expect(handOffCapacity(db, null, 'none-yet')?.room).toBe(30)
  })
})

describe('handOffChain', () => {
  it('walks from the task up, nearest first, naming who handed each out', () => {
    const top = createTask(db, {
      title: 'top',
      status: 'in_progress',
      sourceDelegationId: 'r1:deleg:agent:b:reflectTo:a',
    })
    const mid = createTask(db, {
      title: 'mid',
      parentTaskId: top.id,
      sourceDelegationId: 'r2:deleg:agent:c:reflectTo:b',
    })
    const low = createTask(db, { title: 'low', parentTaskId: mid.id, delegatedByAgentId: 'c' })
    expect(handOffChain(db, low.id).map((l) => [l.id, l.delegatedBy, l.status])).toEqual([
      [low.id, 'c', 'todo'],
      [mid.id, 'b', 'todo'],
      [top.id, 'a', 'in_progress'],
    ])
  })

  it('a person assigned task has no delegator', () => {
    const t = createTask(db, { title: 't', sourceDelegationId: 'assign:n:agent:b:origin:human' })
    expect(handOffChain(db, t.id)[0]?.delegatedBy).toBeNull()
  })

  it('an assign through the Tasks tools records its sender', () => {
    const t = createTask(db, { title: 't' })
    setTaskDelegator(db, t.id, 'a')
    expect(handOffChain(db, t.id)[0]?.delegatedBy).toBe('a')
  })

  it('an unknown task has an empty chain', () => {
    expect(handOffChain(db, 'ghost')).toEqual([])
  })
})

describe('isTeamLeadAgent', () => {
  it("reads the team's lead", () => {
    db.insert(teams)
      .values({
        id: 't',
        name: 'T',
        icon: 'x',
        color: '#0',
        leaderAgentId: 'lead',
        createdAt: 1,
        updatedAt: 1,
      })
      .run()
    expect(isTeamLeadAgent(db, 't', 'lead')).toBe(true)
    expect(isTeamLeadAgent(db, 't', 'other')).toBe(false)
    expect(isTeamLeadAgent(db, null, 'lead')).toBe(false)
  })
})

describe('the delegation failure breaker', () => {
  it('counts across a restart: another connection reads the same count', () => {
    noteDelegationFailure(db, 't', 'a', 'task')
    noteDelegationFailure(db, 't', 'a', 'task')
    const next = createDb(dbPath)
    try {
      expect(readDelegationFailure(next, 't', 'a', 'task')).toEqual({
        failures: 2,
        notified: false,
      })
    } finally {
      next.$client.close()
    }
  })

  it('keeps each team, agent and task apart', () => {
    noteDelegationFailure(db, 't', 'a', 'task')
    expect(readDelegationFailure(db, 'other', 'a', 'task').failures).toBe(0)
    expect(readDelegationFailure(db, 't', 'b', 'task').failures).toBe(0)
    expect(readDelegationFailure(db, 't', 'a', 'else').failures).toBe(0)
  })

  it('a success clears it', () => {
    noteDelegationFailure(db, 't', 'a', 'task')
    clearDelegationFailure(db, 't', 'a', 'task')
    expect(readDelegationFailure(db, 't', 'a', 'task').failures).toBe(0)
  })

  it('remembers it told the delegator once', () => {
    noteDelegationFailure(db, 't', 'a', 'task')
    markDelegationFailureNotified(db, 't', 'a', 'task')
    expect(readDelegationFailure(db, 't', 'a', 'task').notified).toBe(true)
  })

  it('runs out after the window, so an old failure does not refuse forever', () => {
    const at = Date.now()
    noteDelegationFailure(db, 't', 'a', 'task', at - DELEGATION_FAILURE_WINDOW_MS - 1)
    expect(readDelegationFailure(db, 't', 'a', 'task', at).failures).toBe(0)
    noteDelegationFailure(db, 't', 'a', 'task', at)
    expect(readDelegationFailure(db, 't', 'a', 'task', at).failures).toBe(1)
  })

  it("clears a whole team's rows at once", () => {
    noteDelegationFailure(db, 't', 'a', 'x')
    noteDelegationFailure(db, 't', 'b', 'y')
    noteDelegationFailure(db, 'other', 'a', 'x')
    clearTeamDelegationFailures(db, 't')
    expect(readDelegationFailure(db, 't', 'a', 'x').failures).toBe(0)
    expect(readDelegationFailure(db, 'other', 'a', 'x').failures).toBe(1)
  })
})
