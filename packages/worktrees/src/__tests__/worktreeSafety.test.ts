// Rebuilding or reaping a task's checkout must never delete work that exists
// only in that folder. Resume, a fresh provision's pre-clean and GC all remove a
// folder before (or instead of) re-adding it, and each used to decide on a
// registration probe that answers `false` for "not listed" and for "git failed"
// alike. These run against real temporary repositories.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  branchExists,
  commitAll,
  isWorktreeRegistered,
  revParse,
  worktreeRegistration,
} from '../git'
import {
  UnsafeWorktreeError,
  gcWorktrees,
  pauseWorktree,
  provisionWorktree,
  resumeWorktree,
} from '../lifecycle'
import { cleanup, git, initRepo, scaffoldInput } from './gitHarness'

/** The checkout's own admin folder in the repository, read from its `.git` file. */
async function adminDirOf(worktreePath: string): Promise<string> {
  const pointer = await readFile(path.join(worktreePath, '.git'), 'utf8')
  return pointer.replace(/^gitdir:\s*/, '').trim()
}

/** Uncommitted work of both kinds: a new file and an edit to a tracked one. */
async function dirty(worktreePath: string): Promise<void> {
  await writeFile(path.join(worktreePath, 'notes.txt'), 'only here\n')
  await writeFile(path.join(worktreePath, 'README.md'), '# repo\n\nedited, not committed\n')
}

/** Old enough for any age threshold, so GC's age test cannot race the clock. */
async function age(dir: string): Promise<void> {
  const old = new Date(Date.now() - 100 * 60 * 60 * 1000)
  await utimes(dir, old, old)
}

async function expectWorkIntact(worktreePath: string): Promise<void> {
  expect(await readFile(path.join(worktreePath, 'notes.txt'), 'utf8')).toBe('only here\n')
  expect(await readFile(path.join(worktreePath, 'README.md'), 'utf8')).toContain('edited')
}

describe('a checkout with uncommitted work is never replaced', () => {
  let repo: string
  beforeEach(async () => {
    repo = await initRepo()
  })
  afterEach(async () => {
    await cleanup(repo)
  })

  it('R1: resume refuses a registered checkout that has changes, and both survive', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'r1',
      scaffold: scaffoldInput('r1'),
    })
    await dirty(wt.worktreePath)

    await expect(resumeWorktree({ repoPath: repo, taskId: 'r1' })).rejects.toThrow(
      /uncommitted changes/,
    )
    await expectWorkIntact(wt.worktreePath)
  })

  it('R2: resume refuses a checkout git no longer lists, and the error names the folder', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'r2',
      scaffold: scaffoldInput('r2'),
    })
    await dirty(wt.worktreePath)
    // A lost admin folder: the checkout is on disk but git cannot read it.
    await rm(await adminDirOf(wt.worktreePath), { recursive: true, force: true })
    expect(await isWorktreeRegistered(repo, wt.worktreePath)).toBe(false)

    const attempt = resumeWorktree({ repoPath: repo, taskId: 'r2' })
    await expect(attempt).rejects.toBeInstanceOf(UnsafeWorktreeError)
    await expect(attempt).rejects.toThrow(wt.worktreePath)
    await expectWorkIntact(wt.worktreePath)
  })

  it('resume still rebuilds a clean checkout and a missing one', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'ok1',
      scaffold: scaffoldInput('ok1'),
    })
    const clean = await resumeWorktree({ repoPath: repo, taskId: 'ok1' })
    expect(clean.worktreePath).toBe(wt.worktreePath)
    expect(await isWorktreeRegistered(repo, wt.worktreePath)).toBe(true)

    await pauseWorktree(repo, clean)
    expect(existsSync(wt.worktreePath)).toBe(false)
    const missing = await resumeWorktree({ repoPath: repo, taskId: 'ok1' })
    expect(await isWorktreeRegistered(repo, missing.worktreePath)).toBe(true)
  })

  it("a fresh provision's pre-clean refuses a checkout with changes", async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'p1',
      scaffold: scaffoldInput('p1'),
    })
    await dirty(wt.worktreePath)

    await expect(
      provisionWorktree({ repoPath: repo, taskId: 'p1', scaffold: scaffoldInput('p1') }),
    ).rejects.toBeInstanceOf(UnsafeWorktreeError)
    await expectWorkIntact(wt.worktreePath)
  })

  it('a fresh provision starts the branch over: commits past the branch point are reset', async () => {
    // Pinned on purpose. Re-attaching a branch with its commits is resume's job;
    // a provision over an existing branch resets it with -B to the branch point.
    // The runner only reaches a provision once resume could not run, and never
    // after resume refused to replace a checkout.
    const branchPoint = await revParse(repo, 'HEAD')
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'b1',
      scaffold: scaffoldInput('b1'),
    })
    await writeFile(path.join(wt.worktreePath, 'work.ts'), 'export const work = 1\n')
    await commitAll(wt.worktreePath, 'agent work')
    const workTip = await revParse(repo, wt.branch)
    await pauseWorktree(repo, wt)
    expect(await branchExists(repo, wt.branch)).toBe(true)

    const again = await provisionWorktree({
      repoPath: repo,
      taskId: 'b1',
      baseSha: branchPoint,
      scaffold: scaffoldInput('b1'),
    })
    expect(existsSync(path.join(again.worktreePath, 'work.ts'))).toBe(false)
    const contains = await git(repo, ['branch', '--contains', workTip, '--list', wt.branch])
    expect(contains.trim()).toBe('')
  })
})

describe('GC never reaps a checkout it cannot save', () => {
  let repo: string
  let elsewhere: string
  beforeEach(async () => {
    repo = await initRepo()
    elsewhere = await mkdtemp(path.join(os.tmpdir(), 'clawboo-wt-gone-'))
  })
  afterEach(async () => {
    await cleanup(repo, elsewhere)
  })

  it('R4: skips an aged, dirty checkout whose registration probe fails, with a reason', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'g1',
      scaffold: scaffoldInput('g1'),
    })
    await dirty(wt.worktreePath)
    await age(wt.worktreePath)
    const root = path.dirname(wt.worktreePath)
    // The repository is unreachable from where GC looks (moved, unmounted), so
    // `git worktree list` fails, while the checkout itself still reads fine.
    const unreachable = path.join(elsewhere, 'repo-moved-away')

    const r = await gcWorktrees({ repoPath: unreachable, rootDir: root, maxAgeMs: 0 })
    expect(r.reaped).not.toContain('g1')
    expect(r.skipped).toContainEqual({ taskId: 'g1', reason: expect.stringMatching(/\S/) })
    await expectWorkIntact(wt.worktreePath)
  })

  it('skips a dirty checkout git no longer lists instead of deleting it', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'g2',
      scaffold: scaffoldInput('g2'),
    })
    await dirty(wt.worktreePath)
    await rm(await adminDirOf(wt.worktreePath), { recursive: true, force: true })
    await age(wt.worktreePath)

    const r = await gcWorktrees({ repoPath: repo, maxAgeMs: 0 })
    expect(r.reaped).not.toContain('g2')
    expect(r.skipped.map((s) => s.taskId)).toContain('g2')
    await expectWorkIntact(wt.worktreePath)
  })

  it('still reaps an empty leftover folder and autosaves a registered dirty one', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'g3',
      scaffold: scaffoldInput('g3'),
    })
    await dirty(wt.worktreePath)
    await age(wt.worktreePath)
    const leftover = path.join(path.dirname(wt.worktreePath), 'g4')
    await mkdir(leftover)
    await age(leftover)

    const r = await gcWorktrees({ repoPath: repo, maxAgeMs: 0 })
    expect(r.reaped.sort()).toEqual(['g3', 'g4'])
    expect(existsSync(leftover)).toBe(false)
    const resumed = await resumeWorktree({ repoPath: repo, taskId: 'g3' })
    await expectWorkIntact(resumed.worktreePath)
  })
})

describe('worktreeRegistration', () => {
  let repo: string
  beforeEach(async () => {
    repo = await initRepo()
  })
  afterEach(async () => {
    await cleanup(repo)
  })

  it('tells "not listed" apart from "git could not answer"', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'w1',
      scaffold: scaffoldInput('w1'),
    })
    expect(await worktreeRegistration(repo, wt.worktreePath)).toBe('registered')
    expect(await worktreeRegistration(repo, path.join(repo, 'not-a-checkout'))).toBe('unregistered')
    expect(await worktreeRegistration(path.join(repo, 'no-such-dir'), wt.worktreePath)).toBe(
      'unknown',
    )
  })
})
