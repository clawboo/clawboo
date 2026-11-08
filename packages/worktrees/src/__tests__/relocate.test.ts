// Moving a task checkout keeps git's links to it: `git worktree move` for an
// ordinary checkout, a rename plus `git worktree repair` for one git refuses to
// move (a locked one). The result is checked on what git lists.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { listWorktreePaths, worktreeRegistration } from '../git'
import { provisionWorktree } from '../lifecycle'
import { isCheckoutAt, relocateWorktree } from '../relocate'
import { cleanup, git, initRepo, scaffoldInput } from './gitHarness'

describe('relocateWorktree', () => {
  let repo: string
  let root: string

  beforeEach(async () => {
    repo = await initRepo()
    root = await mkdtemp(path.join(os.tmpdir(), 'clawboo-wt-relocate-'))
  })
  afterEach(async () => {
    await cleanup(repo, root)
  })

  async function checkout(taskId: string): Promise<string> {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId,
      rootDir: path.join(root, 'old'),
      scaffold: scaffoldInput(taskId),
    })
    await writeFile(path.join(wt.worktreePath, 'work.txt'), 'uncommitted\n')
    return wt.worktreePath
  }

  it('moves a checkout with git, files and registration with it', async () => {
    const from = await checkout('t1')
    const to = path.join(root, 'new', 't1')
    await mkdir(path.dirname(to), { recursive: true })

    expect(await relocateWorktree(repo, from, to)).toEqual({ ok: true, via: 'move' })
    expect(existsSync(from)).toBe(false)
    expect(await readFile(path.join(to, 'work.txt'), 'utf8')).toBe('uncommitted\n')
    expect(await isCheckoutAt(repo, to)).toBe(true)
    expect(await worktreeRegistration(repo, from)).toBe('unregistered')
    // A prune, which clawboo runs often, keeps it.
    await git(repo, ['worktree', 'prune'])
    expect(await isCheckoutAt(repo, to)).toBe(true)
  })

  it('moves a locked checkout by a rename and git worktree repair', async () => {
    const from = await checkout('t2')
    await git(repo, ['worktree', 'lock', from])
    const to = path.join(root, 'new', 't2')
    await mkdir(path.dirname(to), { recursive: true })

    expect(await relocateWorktree(repo, from, to)).toEqual({ ok: true, via: 'repair' })
    expect(await isCheckoutAt(repo, to)).toBe(true)
    await git(repo, ['worktree', 'prune'])
    expect(await isCheckoutAt(repo, to)).toBe(true)
    expect(await git(to, ['status', '--porcelain'])).toContain('work.txt')
  })

  it('changes nothing when the folder cannot be renamed there', async () => {
    const from = await checkout('t3')
    // No parent folder at the destination: both git and the rename fail.
    const to = path.join(root, 'missing-parent', 'deeper', 't3')
    const r = await relocateWorktree(repo, from, to)
    expect(r.ok).toBe(false)
    expect(await isCheckoutAt(repo, from)).toBe(true)
    expect(await readFile(path.join(from, 'work.txt'), 'utf8')).toBe('uncommitted\n')
  })

  it.skipIf(process.platform === 'win32')(
    'isCheckoutAt is false while git still lists the old path, even through a link to the new one',
    async () => {
      const from = await checkout('t5')
      const to = path.join(root, 'new', 't5')
      await mkdir(path.dirname(to), { recursive: true })
      // Renamed without fixing git's links, and a link left at the old path.
      await rename(from, to)
      await symlink(to, from)
      expect(await isCheckoutAt(repo, to)).toBe(false)
      await git(repo, ['worktree', 'repair', to])
      expect(await isCheckoutAt(repo, to)).toBe(true)
    },
  )

  it('isCheckoutAt is false for a folder git does not list, or one inside another', async () => {
    const from = await checkout('t4')
    const plain = path.join(root, 'plain')
    await mkdir(plain, { recursive: true })
    expect(await isCheckoutAt(repo, plain)).toBe(false)
    expect(await isCheckoutAt(repo, path.join(from, 'sub'))).toBe(false)
    expect((await listWorktreePaths(repo)).length).toBe(2)
  })
})
