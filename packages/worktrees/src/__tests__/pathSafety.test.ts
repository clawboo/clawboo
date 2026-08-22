// Task ids arrive from the HTTP API and become a directory name under the
// worktree root, a git branch name, and on pause/complete the target of a
// recursive remove. These tests pin the boundary that keeps a doctored id or a
// doctored stored record from steering any of those out of the root.

import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { assertSafeTaskId, assertWithin, worktreePathFor, branchNameForTask } from '../git'
import { pauseWorktree, completeWorktree } from '../lifecycle'
import type { Worktree } from '../types'

const REPO = path.resolve('/tmp/repo')

const TRAVERSAL_IDS = [
  '../escape',
  '..',
  '.',
  'a/b',
  'a\\b',
  '/abs',
  'C:\\win',
  '',
  '.hidden',
  'has space',
  'nul\u0000byte',
  'x'.repeat(200),
]

describe('task id validation', () => {
  it('accepts the id shapes the board actually produces', () => {
    for (const id of ['t1', 'sor', 'a1b2c3', '0f8d2e1a-4c3b-4f2a-9e1d-8b7a6c5d4e3f', 'task_1.v2']) {
      expect(assertSafeTaskId(id), id).toBe(id)
      expect(branchNameForTask(id)).toBe(`clawboo/task-${id}`)
    }
  })

  it('rejects anything that is not a single plain path segment', () => {
    for (const id of TRAVERSAL_IDS) {
      expect(() => assertSafeTaskId(id), JSON.stringify(id)).toThrow(/unsafe task id/)
    }
  })

  it('keeps every derived worktree path directly under the root', () => {
    const root = path.join(REPO, '.clawboo', 'worktrees')
    expect(worktreePathFor(REPO, 't1')).toBe(path.join(root, 't1'))
    expect(path.dirname(worktreePathFor(REPO, 't1'))).toBe(root)
    for (const id of TRAVERSAL_IDS) {
      expect(() => worktreePathFor(REPO, id), JSON.stringify(id)).toThrow()
    }
  })

  it('honours an overridden root without letting the id leave it', () => {
    const custom = path.resolve('/tmp/custom-root')
    expect(worktreePathFor(REPO, 't1', custom)).toBe(path.join(custom, 't1'))
    expect(() => worktreePathFor(REPO, '../t1', custom)).toThrow()
  })
})

describe('assertWithin', () => {
  it('allows the root itself and anything beneath it', () => {
    const root = path.resolve('/tmp/root')
    expect(assertWithin(root, root)).toBe(root)
    expect(assertWithin(root, path.join(root, 'a', 'b'))).toBe(path.join(root, 'a', 'b'))
  })

  it('rejects siblings, parents, and paths that walk out', () => {
    const root = path.resolve('/tmp/root')
    for (const bad of [
      path.resolve('/tmp'),
      path.resolve('/tmp/rootsibling'),
      path.join(root, '..', 'elsewhere'),
      path.resolve('/'),
    ]) {
      expect(() => assertWithin(root, bad), bad).toThrow(/escapes/)
    }
  })
})

describe('destructive lifecycle ops reject a record that does not own its directory', () => {
  const record = (taskId: string, worktreePath: string): Worktree => ({
    taskId,
    worktreePath,
    branch: `clawboo/task-${taskId}`,
    baseCommit: 'deadbeef',
    detached: false,
  })

  it('refuses a path whose last segment is not the task id', async () => {
    const impostor = record('t1', path.resolve('/tmp/repo/.clawboo/worktrees/other'))
    await expect(pauseWorktree(REPO, impostor)).rejects.toThrow(/does not belong to task/)
    await expect(completeWorktree(REPO, impostor)).rejects.toThrow(/does not belong to task/)
  })

  it('refuses a path that has been pointed at a parent directory', async () => {
    const escaped = record('t1', path.resolve('/'))
    await expect(pauseWorktree(REPO, escaped)).rejects.toThrow(/does not belong to task/)
    const traversed = record('t1', path.resolve('/tmp/repo/.clawboo/worktrees/t1/../..'))
    await expect(completeWorktree(REPO, traversed)).rejects.toThrow(/does not belong to task/)
  })

  it('refuses an unsafe task id before touching the filesystem', async () => {
    const bad = record('../escape', path.resolve('/tmp/repo/.clawboo/worktrees/escape'))
    await expect(pauseWorktree(REPO, bad)).rejects.toThrow(/unsafe task id/)
  })
})
