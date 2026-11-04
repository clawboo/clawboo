// Pause and complete take the list of roots a task's checkout may live under, so
// a checkout recorded under any of them is acted on where it is, and a record
// outside all of them is still refused before anything is removed.

import { existsSync } from 'node:fs'
import { mkdtemp, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { branchExists, isWorktreeRegistered, revParse } from '../git'
import { completeWorktree, gcWorktrees, pauseWorktree, provisionWorktree } from '../lifecycle'
import type { Worktree } from '../types'
import { cleanup, git, initRepo, scaffoldInput } from './gitHarness'

describe('pause and complete across several roots', () => {
  let repo: string
  let base: string
  let dataRoot: string
  let workRoot: string

  beforeEach(async () => {
    repo = await initRepo()
    base = await mkdtemp(path.join(os.tmpdir(), 'clawboo-wt-roots-'))
    dataRoot = path.join(base, 'data', 'worktrees', 'abc')
    workRoot = path.join(base, 'work', 'worktrees', 'abc')
  })

  afterEach(async () => {
    await cleanup(repo, base)
  })

  /** A checkout provisioned under the second root, as a later layout keeps it. */
  async function provisionUnderWorkRoot(taskId = 't1'): Promise<Worktree> {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId,
      rootDir: workRoot,
      scaffold: scaffoldInput(taskId),
    })
    expect(wt.worktreePath).toBe(path.join(workRoot, taskId))
    return wt
  }

  it('pause commits and removes a checkout recorded under the second root', async () => {
    const wt = await provisionUnderWorkRoot()
    await writeFile(path.join(wt.worktreePath, 'feature.ts'), 'export const x = 1\n')

    const res = await pauseWorktree(repo, wt, [dataRoot, workRoot])

    expect(res.committed).toBe(true)
    expect(existsSync(wt.worktreePath)).toBe(false)
    expect(await isWorktreeRegistered(repo, wt.worktreePath)).toBe(false)
    expect(await revParse(repo, wt.branch)).toBe(res.head)
    expect(await git(repo, ['show', `${wt.branch}:feature.ts`])).toBe('export const x = 1\n')
  })

  it('complete with no change cleans up a checkout recorded under the second root', async () => {
    const wt = await provisionUnderWorkRoot()

    const res = await completeWorktree(repo, wt, [dataRoot, workRoot])

    expect(res).toMatchObject({ dirty: false, cleaned: true })
    expect(existsSync(wt.worktreePath)).toBe(false)
    expect(await branchExists(repo, wt.branch)).toBe(false)
  })

  it('complete with a change keeps a checkout recorded under the second root', async () => {
    const wt = await provisionUnderWorkRoot()
    await writeFile(path.join(wt.worktreePath, 'feature.ts'), 'export const x = 1\n')

    const res = await completeWorktree(repo, wt, [dataRoot, workRoot])

    expect(res).toMatchObject({ dirty: true, cleaned: false })
    expect(existsSync(path.join(wt.worktreePath, 'feature.ts'))).toBe(true)
  })

  it('still refuses a record outside every root, and removes nothing', async () => {
    const wt = await provisionUnderWorkRoot()
    const otherRoot = path.join(base, 'elsewhere', 'worktrees', 'abc')

    await expect(pauseWorktree(repo, wt, [dataRoot, otherRoot])).rejects.toThrow(
      /does not belong to task/,
    )
    await expect(completeWorktree(repo, wt, [dataRoot, otherRoot])).rejects.toThrow(
      /does not belong to task/,
    )
    await expect(pauseWorktree(repo, wt, [])).rejects.toThrow(/does not belong to task/)
    expect(existsSync(wt.worktreePath)).toBe(true)
    expect(await branchExists(repo, wt.branch)).toBe(true)
  })

  it('refuses a record that is a root itself, or deeper than one segment', async () => {
    const wt = await provisionUnderWorkRoot()
    const roots = [dataRoot, workRoot]
    for (const worktreePath of [workRoot, path.join(workRoot, 't1', 'src'), dataRoot]) {
      await expect(completeWorktree(repo, { ...wt, worktreePath }, roots)).rejects.toThrow(
        /does not belong to task/,
      )
    }
    expect(existsSync(wt.worktreePath)).toBe(true)
  })

  it('GC leaves alone, and does not count, folders the caller does not own', async () => {
    const mine = await provisionUnderWorkRoot('t1')
    const theirs = await provisionUnderWorkRoot('t2')

    const res = await gcWorktrees({
      repoPath: repo,
      rootDir: workRoot,
      maxAgeMs: 60 * 60 * 1000,
      maxCount: 0,
      owns: (taskId, worktreePath) => taskId === 't1' && worktreePath === mine.worktreePath,
    })

    expect(res.reaped).toEqual(['t1'])
    expect(res.skipped).toEqual([])
    expect(existsSync(mine.worktreePath)).toBe(false)
    expect(existsSync(theirs.worktreePath)).toBe(true)
    expect(await isWorktreeRegistered(repo, theirs.worktreePath)).toBe(true)
  })

  it('GC counts only owned folders toward maxCount', async () => {
    // The folder the caller does not own is the newer one. Counted, it would take
    // the one slot and push the owned folder over the cap.
    const mine = await provisionUnderWorkRoot('t1')
    const theirs = await provisionUnderWorkRoot('t2')
    const now = Date.now()
    await utimes(theirs.worktreePath, new Date(now), new Date(now))
    await utimes(mine.worktreePath, new Date(now - 60_000), new Date(now - 60_000))

    const res = await gcWorktrees({
      repoPath: repo,
      rootDir: workRoot,
      maxAgeMs: 60 * 60 * 1000,
      maxCount: 1,
      now,
      owns: (taskId) => taskId === 't1',
    })

    expect(res.reaped).toEqual([])
    expect(existsSync(mine.worktreePath)).toBe(true)
    expect(existsSync(theirs.worktreePath)).toBe(true)
  })
})
