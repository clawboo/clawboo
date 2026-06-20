// The per-task worktree lifecycle: provision → work → pause/resume → complete,
// plus age/count GC and the detached read-only reviewer. The task's worktree is
// the durable system-of-record any runtime can pick up cold; the board is just
// the dispatcher. All mutating ops are serialized per worktree path so concurrent
// callers can't race on the same checkout.

import { existsSync } from 'node:fs'
import { mkdir, readdir, rm, stat } from 'node:fs/promises'
import path from 'node:path'

import {
  KeyedMutex,
  addWorktree,
  branchExists,
  branchNameForTask,
  commitAll,
  deleteBranch,
  diffStat,
  findScaffoldCommit,
  hasUncommittedChanges,
  isGitRepo,
  isWorktreeRegistered,
  pruneWorktrees,
  removeWorktree,
  resolveBaseSha,
  revParse,
  worktreeRootFor,
} from './git'
import { SOR_FILES, writeScaffold } from './scaffold'
import type { DiffStat, TaskScaffoldInput, Worktree } from './types'

// The system-of-record bookkeeping files — excluded from the "did the agent do
// work?" diff so a worktree that only carries its own scaffold/handoff is empty.
const SOR_FILE_LIST = Object.values(SOR_FILES)

// One mutex shared across the module so every op on a given worktree path is
// serialized regardless of which lifecycle function is called.
const mutex = new KeyedMutex()

const DEFAULT_MAX_AGE_MS = 72 * 60 * 60 * 1000 // 72h (matches the field norm)
const DEFAULT_MAX_COUNT = 25

export interface ProvisionOptions {
  repoPath: string
  taskId: string
  /** Branch point. A SHA is used as-is; otherwise `baseRef` (default HEAD) is resolved. */
  baseSha?: string | null
  baseRef?: string
  /** Override the worktree root (default `<repoPath>/.clawboo/worktrees`). */
  rootDir?: string
  /** The system-of-record scaffold written + committed as the baseline. */
  scaffold: TaskScaffoldInput
}

/**
 * Provision a fresh worktree + branch for a task and write its SoR scaffold.
 *
 * Hardening (the field-tested rules):
 * - **Branch from a commit SHA, never the dirty working tree** — avoids
 *   inheriting uncommitted state and gives a stable diff baseline.
 * - **Orphan-resilient** — force-remove any stale registration + leftover dir
 *   before `worktree add`.
 * - **Branch-collision recovery** — reuse the branch if it already points at the
 *   branch point, else `-B` reset; only fresh provision uses `-b`/`-B`
 *   (re-attach is `resumeWorktree`, which never does, so it can't discard commits).
 * - **Verify both** filesystem existence and git-metadata registration.
 * - **Comprehensive cleanup, then one retry** on failure.
 *
 * The SoR scaffold is committed as the baseline; the returned `baseCommit` is
 * that scaffold commit, so an agent's *work* is measured from it (the scaffold
 * is initialization, not work).
 */
export async function provisionWorktree(opts: ProvisionOptions): Promise<Worktree> {
  const root = worktreeRootFor(opts.repoPath, opts.rootDir)
  const worktreePath = path.join(root, opts.taskId)
  const branch = branchNameForTask(opts.taskId)

  return mutex.run(worktreePath, async () => {
    if (!(await isGitRepo(opts.repoPath))) {
      throw new Error(`not a git repository: ${opts.repoPath}`)
    }
    const branchPoint =
      opts.baseSha?.trim() || (await resolveBaseSha(opts.repoPath, opts.baseRef ?? 'HEAD'))
    await mkdir(root, { recursive: true })

    const attempt = async (): Promise<void> => {
      // Orphan-resilient pre-clean.
      await removeWorktree(opts.repoPath, worktreePath)
      await rm(worktreePath, { recursive: true, force: true })

      if (await branchExists(opts.repoPath, branch)) {
        const existing = await revParse(opts.repoPath, branch)
        if (existing === branchPoint) {
          // Reuse: attach the existing branch (path before commit-ish).
          await addWorktree(opts.repoPath, [worktreePath, branch])
        } else {
          // Reset the branch to the branch point.
          await addWorktree(opts.repoPath, ['-B', branch, worktreePath, branchPoint])
        }
      } else {
        await addWorktree(opts.repoPath, ['-b', branch, worktreePath, branchPoint])
      }

      if (!existsSync(worktreePath) || !(await isWorktreeRegistered(opts.repoPath, worktreePath))) {
        throw new Error('worktree add did not register the worktree')
      }
    }

    try {
      await attempt()
    } catch {
      // Comprehensive cleanup, then one retry.
      await removeWorktree(opts.repoPath, worktreePath)
      await rm(worktreePath, { recursive: true, force: true })
      await pruneWorktrees(opts.repoPath)
      await attempt()
    }

    await writeScaffold(worktreePath, opts.scaffold)
    await commitAll(worktreePath, `clawboo: scaffold task ${opts.taskId}`)
    const baseCommit = await revParse(worktreePath, 'HEAD')

    return { taskId: opts.taskId, worktreePath, branch, baseCommit, detached: false }
  })
}

export interface LoadOptions {
  repoPath: string
  taskId: string
  rootDir?: string
}

/**
 * Reconstruct the `Worktree` handle for an already-provisioned task — its path,
 * branch, and recovered baseline commit (the SoR-scaffold commit) — so callers
 * that only persisted the path/branch (e.g. the board) can pause/complete it.
 */
export async function loadWorktree(opts: LoadOptions): Promise<Worktree> {
  const worktreePath = path.join(worktreeRootFor(opts.repoPath, opts.rootDir), opts.taskId)
  const branch = branchNameForTask(opts.taskId)
  const baseCommit = await findScaffoldCommit(opts.repoPath, branch, opts.taskId)
  return { taskId: opts.taskId, worktreePath, branch, baseCommit, detached: false }
}

export interface ResumeOptions {
  repoPath: string
  taskId: string
  rootDir?: string
}

/**
 * Re-attach a paused task's existing branch into a fresh worktree. NEVER uses
 * `-b`/`-B` (which would discard the branch's commits) — it attaches the branch
 * at its current tip. `baseCommit` is recovered as the SoR-scaffold commit so a
 * later `completeWorktree` diffs against the right baseline.
 */
export async function resumeWorktree(opts: ResumeOptions): Promise<Worktree> {
  const root = worktreeRootFor(opts.repoPath, opts.rootDir)
  const worktreePath = path.join(root, opts.taskId)
  const branch = branchNameForTask(opts.taskId)

  return mutex.run(worktreePath, async () => {
    if (!(await branchExists(opts.repoPath, branch))) {
      throw new Error(`cannot resume: branch ${branch} no longer exists`)
    }
    await removeWorktree(opts.repoPath, worktreePath)
    await rm(worktreePath, { recursive: true, force: true })
    // Attach the existing branch — no -b/-B, so prior commits are preserved.
    await addWorktree(opts.repoPath, [worktreePath, branch])
    const baseCommit = await findScaffoldCommit(opts.repoPath, branch, opts.taskId)
    return { taskId: opts.taskId, worktreePath, branch, baseCommit, detached: false }
  })
}

export interface PauseResult {
  committed: boolean
  head: string
}

/**
 * Pause a worktree: commit any uncommitted work (so nothing is lost), drop the
 * worktree to free disk + process slots, and KEEP the branch. Resume re-creates
 * the worktree from the preserved branch.
 */
export async function pauseWorktree(repoPath: string, worktree: Worktree): Promise<PauseResult> {
  return mutex.run(worktree.worktreePath, async () => {
    let committed = false
    if (
      (await isWorktreeRegistered(repoPath, worktree.worktreePath)) &&
      (await hasUncommittedChanges(worktree.worktreePath))
    ) {
      await commitAll(worktree.worktreePath, `clawboo: pause task ${worktree.taskId}`)
      committed = true
    }
    const head = committed
      ? await revParse(worktree.worktreePath, 'HEAD')
      : await revParse(repoPath, worktree.branch)
    await removeWorktree(repoPath, worktree.worktreePath) // keep the branch
    await rm(worktree.worktreePath, { recursive: true, force: true })
    return { committed, head }
  })
}

export interface CommitResult {
  head: string
  committed: boolean
}

/**
 * Commit any uncommitted work on a worktree's branch and return the resulting
 * HEAD sha — WITHOUT dropping the worktree (unlike `pauseWorktree`). The read-only
 * critic uses this to obtain a real, reviewable commit to detach-checkout: a
 * runtime leaves its work uncommitted in the worktree, so we checkpoint it before
 * provisioning the detached review worktree. A no-op (returns the current HEAD)
 * when the tree is already clean.
 */
export async function commitWorktreeWork(
  repoPath: string,
  worktree: Worktree,
  message?: string,
): Promise<CommitResult> {
  return mutex.run(worktree.worktreePath, async () => {
    let committed = false
    if (
      (await isWorktreeRegistered(repoPath, worktree.worktreePath)) &&
      (await hasUncommittedChanges(worktree.worktreePath))
    ) {
      await commitAll(
        worktree.worktreePath,
        message ?? `clawboo: checkpoint task ${worktree.taskId}`,
      )
      committed = true
    }
    return { head: await revParse(worktree.worktreePath, 'HEAD'), committed }
  })
}

export interface CompleteResult {
  /** Any change vs the baseline (committed delta, uncommitted, or untracked). */
  dirty: boolean
  diffStat: DiffStat
  /** True when an empty-diff worktree was auto-cleaned (worktree + branch gone). */
  cleaned: boolean
}

/**
 * Finish a worktree. **Empty diff → auto-cleanup** (remove worktree, delete
 * branch, prune) — no integration work to do. **Non-empty → retain** the
 * worktree + branch and return the diff-stat; the caller flips the task to
 * `in_review` and the branch awaits the verification/PR gate.
 */
export async function completeWorktree(
  repoPath: string,
  worktree: Worktree,
): Promise<CompleteResult> {
  return mutex.run(worktree.worktreePath, async () => {
    const ds = await diffStat(worktree.worktreePath, worktree.baseCommit, {
      excludePaths: SOR_FILE_LIST,
    })
    if (!ds.dirty) {
      await removeWorktree(repoPath, worktree.worktreePath)
      await rm(worktree.worktreePath, { recursive: true, force: true })
      await deleteBranch(repoPath, worktree.branch)
      return { dirty: false, diffStat: ds, cleaned: true }
    }
    return { dirty: true, diffStat: ds, cleaned: false }
  })
}

export interface GcOptions {
  repoPath: string
  rootDir?: string
  /** Reap worktrees older than this (default 72h). */
  maxAgeMs?: number
  /** Keep at most this many worktrees; reap the oldest beyond it (default 25). */
  maxCount?: number
  /** Return true to skip a still-active task's worktree. */
  isActive?: (taskId: string) => boolean
  /** Injectable clock for tests. */
  now?: number
}

export interface GcResult {
  reaped: string[]
  skipped: { taskId: string; reason: string }[]
  failed: { taskId: string; error: string }[]
}

/**
 * Garbage-collect stale worktrees by age and count. Reaping is **commit-before-
 * drop** (auto-saves any uncommitted work to the branch, then removes only the
 * worktree — the branch is kept, so nothing is lost). Active tasks are skipped;
 * failures are collected and do not abort the sweep ("continue on failure").
 * Only ever touches directories under the clawboo worktree root.
 */
export async function gcWorktrees(opts: GcOptions): Promise<GcResult> {
  const root = worktreeRootFor(opts.repoPath, opts.rootDir)
  const maxAge = opts.maxAgeMs ?? DEFAULT_MAX_AGE_MS
  const maxCount = opts.maxCount ?? DEFAULT_MAX_COUNT
  const now = opts.now ?? Date.now()
  const result: GcResult = { reaped: [], skipped: [], failed: [] }

  let entries
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    return result // no worktree root yet — nothing to GC
  }

  const infos = await Promise.all(
    entries
      .filter((e) => e.isDirectory())
      .map(async (e) => {
        const p = path.join(root, e.name)
        const st = await stat(p)
        return { taskId: e.name, worktreePath: p, mtimeMs: st.mtimeMs }
      }),
  )
  // Newest first; anything past `maxCount` is over-count (reap oldest).
  infos.sort((a, b) => b.mtimeMs - a.mtimeMs)

  for (let i = 0; i < infos.length; i++) {
    const info = infos[i]
    const aged = now - info.mtimeMs > maxAge
    const overCount = i >= maxCount
    if (!aged && !overCount) continue
    if (opts.isActive?.(info.taskId)) {
      result.skipped.push({ taskId: info.taskId, reason: 'active' })
      continue
    }
    try {
      // Reap inside the per-path mutex so a sweep can never interleave with an
      // in-flight provision/pause/complete on the SAME checkout (they all run
      // through `mutex.run`). Re-check isActive immediately before the destructive
      // step: a task that became active between the snapshot above and now is
      // skipped, not reaped (closes the TOCTOU on the locked-set snapshot).
      const reaped = await mutex.run(info.worktreePath, async () => {
        if (opts.isActive?.(info.taskId)) {
          result.skipped.push({ taskId: info.taskId, reason: 'active' })
          return false
        }
        // Commit-before-drop so reaping can never eat uncommitted work.
        if (
          (await isWorktreeRegistered(opts.repoPath, info.worktreePath)) &&
          (await hasUncommittedChanges(info.worktreePath))
        ) {
          await commitAll(info.worktreePath, `clawboo: gc autosave task ${info.taskId}`)
        }
        await removeWorktree(opts.repoPath, info.worktreePath) // keep the branch
        await rm(info.worktreePath, { recursive: true, force: true })
        return true
      })
      if (reaped) result.reaped.push(info.taskId)
    } catch (err) {
      result.failed.push({ taskId: info.taskId, error: String(err) })
    }
  }
  await pruneWorktrees(opts.repoPath)
  return result
}

export interface ReviewOptions {
  repoPath: string
  /** The commit to review (a detached, read-only checkout is made at it). */
  sha: string
  rootDir?: string
}

/**
 * Provision a **detached** read-only reviewer worktree at a specific commit.
 * Detached HEAD = no branch, so a reviewer has nothing to push: review can never
 * mutate a teammate's branch. (Tool-level write denial is the runtime's job —
 * e.g. an OpenClaw read-only sandbox; this gives the structural guarantee.)
 */
export async function provisionReviewWorktree(opts: ReviewOptions): Promise<Worktree> {
  const reviewRoot = opts.rootDir ?? path.join(opts.repoPath, '.clawboo', 'reviews')
  const shortSha = opts.sha.slice(0, 12)
  const worktreePath = path.join(reviewRoot, shortSha)

  return mutex.run(worktreePath, async () => {
    if (!(await isGitRepo(opts.repoPath))) {
      throw new Error(`not a git repository: ${opts.repoPath}`)
    }
    await removeWorktree(opts.repoPath, worktreePath)
    await rm(worktreePath, { recursive: true, force: true })
    await mkdir(reviewRoot, { recursive: true })
    await addWorktree(opts.repoPath, ['--detach', worktreePath, opts.sha])
    if (!existsSync(worktreePath) || !(await isWorktreeRegistered(opts.repoPath, worktreePath))) {
      throw new Error('review worktree add did not register the worktree')
    }
    return { taskId: '', worktreePath, branch: '', baseCommit: opts.sha, detached: true }
  })
}

/** Tear down a review worktree (no branch to delete — it was detached). */
export async function removeReviewWorktree(repoPath: string, worktree: Worktree): Promise<void> {
  await mutex.run(worktree.worktreePath, async () => {
    await removeWorktree(repoPath, worktree.worktreePath)
    await rm(worktree.worktreePath, { recursive: true, force: true })
  })
}
