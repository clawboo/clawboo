import { existsSync } from 'node:fs'
import { utimes, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { branchExists, isDetached, resolveBaseSha, revParse } from '../git'
import { commitAll } from '../git'
import {
  completeWorktree,
  gcWorktrees,
  pauseWorktree,
  provisionReviewWorktree,
  provisionWorktree,
  removeReviewWorktree,
  resumeWorktree,
} from '../lifecycle'
import { reconstructState, writeHandoff } from '../handoff'
import { SOR_FILES } from '../scaffold'
import { cleanup, git, initRepo, scaffoldInput } from './gitHarness'

describe('worktree lifecycle', () => {
  let repo: string
  beforeEach(async () => {
    repo = await initRepo()
  })
  afterEach(async () => {
    await cleanup(repo)
  })

  it('provisions a worktree + branch + SoR scaffold from a base SHA, committed as the baseline', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 't1',
      scaffold: scaffoldInput('t1'),
    })

    expect(wt.branch).toBe('clawboo/task-t1')
    expect(wt.detached).toBe(false)
    expect(await branchExists(repo, 'clawboo/task-t1')).toBe(true)

    // All five SoR files present.
    for (const leaf of [
      SOR_FILES.task,
      SOR_FILES.progress,
      SOR_FILES.decisions,
      SOR_FILES.init,
      SOR_FILES.verification,
    ]) {
      expect(existsSync(path.join(wt.worktreePath, leaf)), leaf).toBe(true)
    }
    // Scaffold committed → clean working tree; baseCommit is HEAD.
    expect((await git(wt.worktreePath, ['status', '--porcelain'])).trim()).toBe('')
    expect(wt.baseCommit).toBe(await revParse(wt.worktreePath, 'HEAD'))
  })

  it('branches from a commit SHA, not the dirty working tree', async () => {
    // Dirty the source repo: an uncommitted file that must NOT leak into the worktree.
    await writeFile(path.join(repo, 'dirty.txt'), 'uncommitted')
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 't2',
      scaffold: scaffoldInput('t2'),
    })
    expect(existsSync(path.join(wt.worktreePath, 'dirty.txt'))).toBe(false)
  })

  it('recovers from a branch collision without throwing', async () => {
    const a = await provisionWorktree({
      repoPath: repo,
      taskId: 't3',
      scaffold: scaffoldInput('t3'),
    })
    // Drop the worktree but keep the branch (a leftover from a prior run).
    await pauseWorktree(repo, a)
    expect(await branchExists(repo, 'clawboo/task-t3')).toBe(true)
    // Re-provisioning the same task reuses/resets the branch cleanly.
    const b = await provisionWorktree({
      repoPath: repo,
      taskId: 't3',
      scaffold: scaffoldInput('t3'),
    })
    expect(b.branch).toBe('clawboo/task-t3')
    expect(existsSync(path.join(b.worktreePath, SOR_FILES.task))).toBe(true)
  })

  it('pause commits + drops the worktree but keeps the branch; resume re-attaches with work intact', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 't4',
      scaffold: scaffoldInput('t4'),
    })
    await writeFile(path.join(wt.worktreePath, 'wip.ts'), 'export const wip = 1\n')

    const paused = await pauseWorktree(repo, wt)
    expect(paused.committed).toBe(true)
    expect(existsSync(wt.worktreePath)).toBe(false) // worktree dropped
    expect(await branchExists(repo, wt.branch)).toBe(true) // branch kept

    const resumed = await resumeWorktree({ repoPath: repo, taskId: 't4' })
    expect(existsSync(path.join(resumed.worktreePath, 'wip.ts'))).toBe(true) // commit preserved
    expect(resumed.baseCommit).toBe(wt.baseCommit) // same scaffold-commit baseline
  })

  it('complete with an empty diff auto-cleans the worktree + branch', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 't5',
      scaffold: scaffoldInput('t5'),
    })
    const r = await completeWorktree(repo, wt)
    expect(r.dirty).toBe(false)
    expect(r.cleaned).toBe(true)
    expect(existsSync(wt.worktreePath)).toBe(false)
    expect(await branchExists(repo, wt.branch)).toBe(false)
  })

  it('treats SoR bookkeeping (handoff) as non-work — a handoff-only session still auto-cleans', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'sor',
      scaffold: scaffoldInput('sor'),
    })
    // Clock-out bookkeeping only — write a handoff, no deliverable files.
    await writeHandoff(wt.worktreePath, {
      handoffFrom: 'A',
      runtime: 'codex',
      completedSubtasks: [],
      brokenOrUnverified: [],
      nextBestStep: '',
      commands: { init: './init.sh', verify: '', start: '' },
      evidence: {},
      warnings: [],
    })
    const r = await completeWorktree(repo, wt)
    expect(r.dirty).toBe(false)
    expect(r.cleaned).toBe(true)
  })

  it('complete with a non-empty diff retains the worktree + branch and reports the diff-stat', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 't6',
      scaffold: scaffoldInput('t6'),
    })
    await writeFile(path.join(wt.worktreePath, 'feature.ts'), 'export const x = 1\n')
    const r = await completeWorktree(repo, wt)
    expect(r.dirty).toBe(true)
    expect(r.cleaned).toBe(false)
    expect(r.diffStat.filesChanged).toBeGreaterThanOrEqual(1)
    expect(existsSync(wt.worktreePath)).toBe(true) // retained for review
    expect(await branchExists(repo, wt.branch)).toBe(true)
  })

  it('GC reaps over-count worktrees, skips active ones, and commits-before-drop (no lost work)', async () => {
    const w1 = await provisionWorktree({
      repoPath: repo,
      taskId: 'g1',
      scaffold: scaffoldInput('g1'),
    })
    await provisionWorktree({ repoPath: repo, taskId: 'g2', scaffold: scaffoldInput('g2') })
    await provisionWorktree({ repoPath: repo, taskId: 'g3', scaffold: scaffoldInput('g3') })
    // Uncommitted work in g1 — GC must auto-save it, never eat it.
    await writeFile(path.join(w1.worktreePath, 'precious.ts'), 'export const keep = 1\n')

    // Keep at most 1; g2 + g3 are over-count, but mark g3 active → skipped.
    const r = await gcWorktrees({ repoPath: repo, maxCount: 1, isActive: (id) => id === 'g3' })
    expect(r.skipped.some((s) => s.taskId === 'g3')).toBe(true)
    expect(r.failed).toHaveLength(0)

    // Force-reap g1 (maxCount 0) and prove its uncommitted work survived on the branch.
    await gcWorktrees({ repoPath: repo, maxCount: 0, isActive: (id) => id !== 'g1' })
    const resumed = await resumeWorktree({ repoPath: repo, taskId: 'g1' })
    expect(existsSync(path.join(resumed.worktreePath, 'precious.ts'))).toBe(true)
  })

  it('GC re-checks isActive INSIDE the per-path mutex — a task that becomes active before the reap is skipped, not reaped', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'race1',
      scaffold: scaffoldInput('race1'),
    })
    // isActive returns false at the snapshot check, then true at the in-mutex
    // re-check — the TOCTOU window. The reap must be skipped (not eat live work).
    let calls = 0
    const isActive = (id: string): boolean => (id === 'race1' ? calls++ >= 1 : false)
    const r = await gcWorktrees({ repoPath: repo, maxCount: 0, isActive })
    expect(r.skipped.some((s) => s.taskId === 'race1')).toBe(true)
    expect(r.reaped).not.toContain('race1')
    expect(existsSync(wt.worktreePath)).toBe(true) // the re-check saved the checkout
  })

  it('GC over an age threshold reaps an aged worktree and tolerates a missing root', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'age1',
      scaffold: scaffoldInput('age1'),
    })
    const old = new Date(Date.now() - 100 * 60 * 60 * 1000) // 100h ago
    await utimes(wt.worktreePath, old, old)
    const r = await gcWorktrees({ repoPath: repo, maxAgeMs: 72 * 60 * 60 * 1000, maxCount: 999 })
    expect(r.reaped).toContain('age1')
    // No worktree root at all → empty result, no throw.
    const empty = await gcWorktrees({ repoPath: repo, rootDir: path.join(repo, 'nope') })
    expect(empty.reaped).toHaveLength(0)
  })

  it('provisions a detached read-only reviewer worktree (no branch to push)', async () => {
    const sha = await resolveBaseSha(repo, 'HEAD')
    const review = await provisionReviewWorktree({ repoPath: repo, sha })
    expect(review.detached).toBe(true)
    expect(review.branch).toBe('')
    expect(await isDetached(review.worktreePath)).toBe(true)
    await removeReviewWorktree(repo, review)
    expect(existsSync(review.worktreePath)).toBe(false)
  })

  it('cross-runtime cold handoff: a DIFFERENT runtime reconstructs state from the worktree alone', async () => {
    // Runtime A provisions, does work, and clocks out (structured handoff + commit).
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'handoff',
      scaffold: scaffoldInput('handoff'),
    })
    await writeFile(path.join(wt.worktreePath, 'feature.ts'), 'export const x = 1\n')
    await writeHandoff(wt.worktreePath, {
      handoffFrom: 'Builder Boo',
      runtime: 'claude-code',
      completedSubtasks: ['parsed the input', 'added feature.ts'],
      brokenOrUnverified: ['large-file path untested'],
      nextBestStep: 'wire feature.ts into the index',
      commands: { init: './init.sh', verify: 'pnpm test', start: 'pnpm dev' },
      evidence: { testResults: '3 passed', lintResults: null },
      warnings: ['watch the provider rate limit'],
    })
    await commitAll(wt.worktreePath, 'clock-out')

    // Runtime B (a different runtime) resumes — reading ONLY worktree files.
    const state = await reconstructState(wt.worktreePath)
    expect(state.hasHandoff).toBe(true)
    expect(state.lastRuntime).toBe('claude-code')
    expect(state.done).toContain('added feature.ts')
    expect(state.broken).toContain('large-file path untested')
    expect(state.next).toBe('wire feature.ts into the index')
    expect(state.commands.verify).toBe('pnpm test')
    expect(state.warnings).toContain('watch the provider rate limit')
  })
})
