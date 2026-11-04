// What counts as "nothing to lose" before a task folder is replaced. A clean
// `git status` is not enough on its own: git leaves ignored files out of it, a
// folder can be a separate repository with commits of its own, and a detached
// checkout can hold a commit no branch keeps. These run against real
// temporary repositories.

import { existsSync } from 'node:fs'
import { readFile, rm, utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { commitAll, revParse } from '../git'
import { UnsafeWorktreeError, gcWorktrees, provisionWorktree, resumeWorktree } from '../lifecycle'
import { cleanup, git, initRepo, scaffoldInput } from './gitHarness'

/** Turn the task checkout into a repository of its own, with one commit only it holds. */
async function makeStandaloneRepo(worktreePath: string): Promise<void> {
  await rm(path.join(worktreePath, '.git'), { force: true })
  await git(worktreePath, ['init', '-b', 'work'])
  await git(worktreePath, ['config', 'user.name', 'agent'])
  await git(worktreePath, ['config', 'user.email', 'agent@example.com'])
  await git(worktreePath, ['config', 'core.autocrlf', 'false'])
  await writeFile(path.join(worktreePath, 'only-here.txt'), 'committed only here\n')
  await git(worktreePath, ['add', '-A'])
  await git(worktreePath, ['commit', '--no-verify', '-m', 'work kept only here'])
}

/** A committed `.gitignore` for `.env`, then an `.env` git will never save. */
async function addIgnoredEnv(worktreePath: string): Promise<void> {
  await writeFile(path.join(worktreePath, '.gitignore'), '.env\n')
  await commitAll(worktreePath, 'ignore .env')
  await writeFile(path.join(worktreePath, '.env'), 'API_KEY=kept\n')
}

async function age(dir: string): Promise<void> {
  const old = new Date(Date.now() - 100 * 60 * 60 * 1000)
  await utimes(dir, old, old)
}

describe('a folder git calls clean can still hold work', () => {
  let repo: string
  beforeEach(async () => {
    repo = await initRepo()
  })
  afterEach(async () => {
    await cleanup(repo)
  })

  it('a separate repository at the task path is never replaced, by resume or a provision', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 's1',
      scaffold: scaffoldInput('s1'),
    })
    await makeStandaloneRepo(wt.worktreePath)
    const ownCommit = await revParse(wt.worktreePath, 'HEAD')

    await expect(resumeWorktree({ repoPath: repo, taskId: 's1' })).rejects.toBeInstanceOf(
      UnsafeWorktreeError,
    )
    await expect(
      provisionWorktree({ repoPath: repo, taskId: 's1', scaffold: scaffoldInput('s1') }),
    ).rejects.toThrow(/separate git repository/)
    expect(await revParse(wt.worktreePath, 'HEAD')).toBe(ownCommit)
    expect(await readFile(path.join(wt.worktreePath, 'only-here.txt'), 'utf8')).toContain('only')
  })

  it('GC skips a separate repository at the task path instead of deleting it', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 's2',
      scaffold: scaffoldInput('s2'),
    })
    await makeStandaloneRepo(wt.worktreePath)
    await age(wt.worktreePath)

    const r = await gcWorktrees({ repoPath: repo, maxAgeMs: 0 })
    expect(r.reaped).not.toContain('s2')
    expect(r.skipped).toContainEqual({ taskId: 's2', reason: expect.stringMatching(/separate/) })
    expect(existsSync(path.join(wt.worktreePath, 'only-here.txt'))).toBe(true)
  })

  it('resume keeps a clean checkout on the task branch as it is, ignored files included', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'i1',
      scaffold: scaffoldInput('i1'),
    })
    await addIgnoredEnv(wt.worktreePath)

    const resumed = await resumeWorktree({ repoPath: repo, taskId: 'i1' })
    expect(resumed.worktreePath).toBe(wt.worktreePath)
    expect(resumed.baseCommit).toBe(wt.baseCommit)
    expect(await readFile(path.join(wt.worktreePath, '.env'), 'utf8')).toBe('API_KEY=kept\n')
  })

  it('a provision refuses a checkout whose only extra files are ones git ignores', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'i2',
      scaffold: scaffoldInput('i2'),
    })
    await addIgnoredEnv(wt.worktreePath)

    await expect(
      provisionWorktree({ repoPath: repo, taskId: 'i2', scaffold: scaffoldInput('i2') }),
    ).rejects.toThrow(/ignores/)
    expect(await readFile(path.join(wt.worktreePath, '.env'), 'utf8')).toBe('API_KEY=kept\n')
  })

  it('resume refuses a detached checkout whose commit is on no branch', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'd1',
      scaffold: scaffoldInput('d1'),
    })
    await git(wt.worktreePath, ['checkout', '--detach'])
    await writeFile(path.join(wt.worktreePath, 'detached.ts'), 'export const d = 1\n')
    await commitAll(wt.worktreePath, 'work on no branch')
    const lonely = await revParse(wt.worktreePath, 'HEAD')

    await expect(resumeWorktree({ repoPath: repo, taskId: 'd1' })).rejects.toThrow(/no branch/)
    expect(await revParse(wt.worktreePath, 'HEAD')).toBe(lonely)
    expect(existsSync(path.join(wt.worktreePath, 'detached.ts'))).toBe(true)
  })
})
