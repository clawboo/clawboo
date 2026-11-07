// A task is created once: idempotency keys on every create path, and the
// same-title check on agent-created tasks.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { tasks } from '../../schema'
import { onBoardLifecycle, resetBoardLifecycleListeners, type BoardLifecycleEvent } from '../events'
import {
  SAME_TASK_WINDOW_MS,
  claimTask,
  completeExecutionProcess,
  createCappedRootTask,
  createCappedSubtask,
  createExecutionProcess,
  createTask,
  dropTask,
  listTasks,
  updateStatus,
} from '../repository'

let dir: string
let db: ClawbooDb

const age = (id: string, ms: number): void => {
  db.update(tasks)
    .set({ createdAt: Date.now() - ms })
    .where(eq(tasks.id, id))
    .run()
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-create-dedupe-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  resetBoardLifecycleListeners()
  db.$client.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('idempotency keys', () => {
  it('the same create retried with the same key returns the same task, once', () => {
    const seen: BoardLifecycleEvent[] = []
    onBoardLifecycle((e) => seen.push(e))
    const key = { key: 'draft-1' }
    const first = createTask(db, { title: 'a', teamId: 't', createKey: key })
    const again = createTask(db, { title: 'a', teamId: 't', createKey: key })
    expect(first.deduplicated).toBeUndefined()
    expect(again.id).toBe(first.id)
    expect(again.deduplicated).toBe(true)
    expect(again.deduplicatedBy).toBe('key')
    expect(listTasks(db)).toHaveLength(1)
    expect(seen.filter((e) => e.kind === 'task_created')).toHaveLength(1)
  })

  it('a replay is the original even when its words changed', () => {
    const key = { key: 'k' }
    const first = createTask(db, { title: 'first words', createKey: key })
    expect(createTask(db, { title: 'other words', createKey: key }).id).toBe(first.id)
  })

  it('a different key is a different task, and no key never matches', () => {
    const a = createTask(db, { title: 'a', createKey: { key: '1' } })
    const b = createTask(db, { title: 'a', createKey: { key: '2' } })
    const c = createTask(db, { title: 'a' })
    const d = createTask(db, { title: 'a' })
    expect(new Set([a.id, b.id, c.id, d.id]).size).toBe(4)
  })

  it('a key holds across create paths', () => {
    const r = createCappedRootTask(db, { title: 'a', createKey: { key: 'k' } })
    expect(r.ok).toBe(true)
    const again = createTask(db, { title: 'a', createKey: { key: 'k' } })
    expect(r.ok && again.id === r.task.id).toBe(true)
  })

  it('a replay is not refused by a cap the original got past', () => {
    const parent = createTask(db, { title: 'p' })
    const key = { key: 'k' }
    const first = createCappedSubtask(
      db,
      parent.id,
      { title: 'c', createKey: key },
      { maxChildren: 1 },
    )
    const again = createCappedSubtask(
      db,
      parent.id,
      { title: 'c', createKey: key },
      { maxChildren: 1 },
    )
    expect(first.ok && again.ok && again.task.id === first.task.id).toBe(true)
    expect(again.ok && again.task.deduplicated).toBe(true)
  })

  it('a named key stays good however long it has been and whatever became of the task', () => {
    const t = createTask(db, { title: 'a', createKey: { key: 'k' } })
    updateStatus(db, t.id, 'blocked')
    db.update(tasks).set({ createdAt: 1 }).where(eq(tasks.id, t.id)).run()
    expect(createTask(db, { title: 'a', createKey: { key: 'k' } }).id).toBe(t.id)
  })

  it('a dropped original frees its key', () => {
    const t = createTask(db, { title: 'a', createKey: { key: 'k' } })
    dropTask(db, t.id)
    const next = createTask(db, { title: 'a', createKey: { key: 'k' } })
    expect(next.id).not.toBe(t.id)
    expect(next.deduplicated).toBeUndefined()
  })

  describe('a key the server made up', () => {
    const derived = { key: 'derived', derived: true }

    it('returns the original inside the window, even a finished one', () => {
      const t = createTask(db, { title: 'a', createKey: derived })
      updateStatus(db, t.id, 'in_progress')
      expect(updateStatus(db, t.id, 'done').ok).toBe(true)
      expect(createTask(db, { title: 'a', createKey: derived }).id).toBe(t.id)
    })

    it('runs out after the window', () => {
      const t = createTask(db, { title: 'a', createKey: derived })
      db.$client
        .prepare('UPDATE task_create_keys SET created_at = ? WHERE key = ?')
        .run(Date.now() - SAME_TASK_WINDOW_MS - 1, derived.key)
      const next = createTask(db, { title: 'a', createKey: derived })
      expect(next.id).not.toBe(t.id)
      expect(createTask(db, { title: 'a', createKey: derived }).id).toBe(next.id)
    })

    it('does not swallow a retry of a blocked task', () => {
      const t = createTask(db, { title: 'a', createKey: derived })
      updateStatus(db, t.id, 'blocked')
      const next = createTask(db, { title: 'a', createKey: derived })
      expect(next.id).not.toBe(t.id)
    })
  })
})

describe('same-title dedupe', () => {
  const asAgent = { agentCreated: true }

  it('counts a task waiting on other work as open, and no other Blocked task', () => {
    const asAgent = { title: 'Ship it', teamId: 't', agentCreated: true } as const
    const first = createTask(db, { ...asAgent, status: 'todo' })
    claimTask(db, first.id, 'a')
    updateStatus(db, first.id, 'blocked', { waitingOn: { kind: 'subtasks', handedOut: true } })
    expect(createTask(db, asAgent)).toMatchObject({
      id: first.id,
      deduplicated: true,
      deduplicatedBy: 'title',
    })
    updateStatus(db, first.id, 'blocked', { waitingOn: { kind: 'failure' } })
    expect(createTask(db, asAgent).id).not.toBe(first.id)
  })

  it('returns an open task with the same words instead of a new one', () => {
    const t = createTask(db, { title: 'Write the tests', teamId: 't', ...asAgent })
    const again = createTask(db, { title: '  write THE tests. ', teamId: 't', ...asAgent })
    expect(again.id).toBe(t.id)
    expect(again.deduplicated).toBe(true)
    expect(again.deduplicatedBy).toBe('title')
    expect(listTasks(db)).toHaveLength(1)
  })

  it('catches 3 near-identical sub-tasks from one run', () => {
    const parent = createTask(db, { title: 'p', teamId: 't' })
    const results = ['Add login', 'add login', 'ADD LOGIN!'].map((title) =>
      createCappedSubtask(db, parent.id, { title, ...asAgent }),
    )
    expect(listTasks(db).filter((t) => t.parentTaskId === parent.id)).toHaveLength(1)
    expect(results.every((r) => r.ok)).toBe(true)
  })

  it('applies to a capped root create too, before the rate cap', () => {
    const first = createCappedRootTask(
      db,
      { title: 'a', teamId: 't', ...asAgent },
      { maxRootCreates: 1 },
    )
    const again = createCappedRootTask(
      db,
      { title: 'a', teamId: 't', ...asAgent },
      { maxRootCreates: 1 },
    )
    expect(first.ok && again.ok && again.task.id === first.task.id).toBe(true)
  })

  it("a person's own create skips it", () => {
    const t = createTask(db, { title: 'a', teamId: 't', ...asAgent })
    expect(createTask(db, { title: 'a', teamId: 't' }).id).not.toBe(t.id)
  })

  it.each(['blocked', 'done', 'cancelled'] as const)('a %s task is left out', (status) => {
    const t = createTask(db, { title: 'a', teamId: 't', ...asAgent })
    if (status === 'done') updateStatus(db, t.id, 'in_progress')
    expect(updateStatus(db, t.id, status).ok).toBe(true)
    expect(createTask(db, { title: 'a', teamId: 't', ...asAgent }).id).not.toBe(t.id)
  })

  it.each(['backlog', 'todo', 'in_progress', 'in_review'] as const)(
    'a %s task counts',
    (status) => {
      const t = createTask(db, { title: 'a', teamId: 't', status, ...asAgent })
      expect(createTask(db, { title: 'a', teamId: 't', ...asAgent }).id).toBe(t.id)
    },
  )

  it('looks only under the same parent, team and room', () => {
    const p1 = createTask(db, { title: 'p1', teamId: 't' })
    const p2 = createTask(db, { title: 'p2', teamId: 't' })
    const a = createCappedSubtask(db, p1.id, { title: 'c', ...asAgent })
    const b = createCappedSubtask(db, p2.id, { title: 'c', ...asAgent })
    expect(a.ok && b.ok && a.task.id !== b.task.id).toBe(true)

    const root = createTask(db, { title: 'r', teamId: 't', ...asAgent })
    expect(createTask(db, { title: 'r', teamId: 'other', ...asAgent }).id).not.toBe(root.id)
    expect(createTask(db, { title: 'r', teamId: 't', roomId: 'room', ...asAgent }).id).not.toBe(
      root.id,
    )
    expect(
      createTask(db, { title: 'p1', teamId: 't', parentTaskId: p1.id, ...asAgent }).id,
    ).not.toBe(p1.id)
  })

  it('looks back 48 hours and no further', () => {
    const t = createTask(db, { title: 'a', teamId: 't', ...asAgent })
    age(t.id, SAME_TASK_WINDOW_MS - 60_000)
    expect(createTask(db, { title: 'a', teamId: 't', ...asAgent }).id).toBe(t.id)
    age(t.id, SAME_TASK_WINDOW_MS + 60_000)
    expect(createTask(db, { title: 'a', teamId: 't', ...asAgent }).id).not.toBe(t.id)
  })

  it('a hand-off matches only a task someone is on', () => {
    const card = createTask(db, { title: 'Clean up', teamId: 't', status: 'todo' })
    const handOff = { teamId: 't', agentCreated: true, titleMatchNeedsOwner: true }
    const first = createTask(db, {
      ...handOff,
      title: 'Clean up',
      sourceDelegationId: 'r1:deleg:agent:a:reflectTo:b',
    })
    expect(first.id).not.toBe(card.id)
    const second = createTask(db, { ...handOff, title: 'clean up' })
    expect(second.id).toBe(first.id)
  })

  it('a hand-off does not match a parked Backlog card, even one bound to an agent', () => {
    const card = createTask(db, {
      title: 'Clean up',
      teamId: 't',
      status: 'backlog',
      sourceDelegationId: 'assign:n:agent:a:origin:human',
    })
    const handOff = { teamId: 't', agentCreated: true, titleMatchNeedsOwner: true }
    expect(createTask(db, { ...handOff, title: 'clean up' }).id).not.toBe(card.id)
    // A create with no target is not waiting on anything, so the card still stands in.
    const parked = createTask(db, { title: 'Parked', teamId: 't', status: 'backlog' })
    expect(createTask(db, { title: 'parked', teamId: 't', agentCreated: true }).id).toBe(parked.id)
  })

  it('tasks from the same turn do not stand in for each other', () => {
    const fromTurn = (turn: string, target: string) => ({
      title: 'Same words',
      teamId: 't',
      agentCreated: true,
      titleMatchNeedsOwner: true,
      titleMatchExceptTurn: turn,
      sourceDelegationId: `${turn}:deleg:agent:${target}:reflectTo:lead`,
    })
    const a = createTask(db, fromTurn('turn-1', 'a'))
    const b = createTask(db, fromTurn('turn-1', 'b'))
    expect(b.id).not.toBe(a.id)
    const later = createTask(db, fromTurn('turn-2', 'c'))
    expect(later.id).toBe(a.id)
    expect(later.deduplicatedBy).toBe('title')
  })

  it('a key marked open-only does not match a finished or cancelled original', () => {
    const key = { key: 'team-wide', derived: true, openOnly: true }
    const t = createTask(db, { title: 'a', teamId: 't', createKey: key })
    expect(createTask(db, { title: 'a', teamId: 't', createKey: key }).id).toBe(t.id)
    updateStatus(db, t.id, 'in_progress')
    expect(updateStatus(db, t.id, 'done').ok).toBe(true)
    const next = createTask(db, { title: 'a', teamId: 't', createKey: key })
    expect(next.id).not.toBe(t.id)
    expect(updateStatus(db, next.id, 'cancelled').ok).toBe(true)
    expect(createTask(db, { title: 'a', teamId: 't', createKey: key }).id).not.toBe(next.id)
  })

  it('a task the pump will not start by itself is left out', () => {
    const t = createTask(db, { title: 'stopped', teamId: 't', ...asAgent })
    const exec = createExecutionProcess(db, { taskId: t.id, executorType: 'openclaw' })
    completeExecutionProcess(db, exec.id, { status: 'cancelled' })
    expect(createTask(db, { title: 'stopped', teamId: 't', ...asAgent }).id).not.toBe(t.id)
  })

  it('a long hand-off title may be cut, so two different asks stay two tasks', () => {
    const start = 'x'.repeat(200)
    const a = createTask(db, { title: start, description: `${start} one`, teamId: 't', ...asAgent })
    const b = createTask(db, { title: start, description: `${start} two`, teamId: 't', ...asAgent })
    const c = createTask(db, { title: start, description: `${start} two`, teamId: 't', ...asAgent })
    expect(b.id).not.toBe(a.id)
    expect(c.id).toBe(b.id)
  })

  it('a key that matched by title returns that task on replay, even after it closed', () => {
    const t = createTask(db, { title: 'a', teamId: 't', ...asAgent })
    const key = { key: 'k' }
    expect(createTask(db, { title: 'a', teamId: 't', createKey: key, ...asAgent }).id).toBe(t.id)
    updateStatus(db, t.id, 'in_progress')
    expect(updateStatus(db, t.id, 'done').ok).toBe(true)
    const replay = createTask(db, { title: 'a', teamId: 't', createKey: key, ...asAgent })
    expect(replay.id).toBe(t.id)
    expect(replay.deduplicatedBy).toBe('key')
  })
})
