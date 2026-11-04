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
  checkoutContents,
  commitAll,
  execGit,
  deleteBranch,
  diffStat,
  findScaffoldCommit,
  hasUncommittedChanges,
  isDetached,
  isGitRepo,
  isWorktreeRegistered,
  pruneWorktrees,
  removeWorktree,
  resolveBaseSha,
  revParse,
  worktreePathFor,
  worktreeRegistration,
  worktreeRootFor,
} from './git'
import { SOR_FILES, writeScaffold } from './scaffold'
import type { CheckoutContents } from './git'
import type { DiffStat, TaskScaffoldInput, Worktree } from './types'

/**
 * The roots a task's checkout may live under. One root, or none (the default
 * root), is the usual case; a list names every root a recorded checkout may
 * still be under, such as an older and a newer layout.
 */
export type WorktreeRoots = string | readonly string[] | undefined

/**
 * The directory a worktree record owns, or a thrown error.
 *
 * `pauseWorktree` / `completeWorktree` recursively remove a directory named by a
 * stored record, so the location they act on is REBUILT here from a worktree
 * root and the task's validated id rather than taken from the record verbatim.
 * The record has to equal the rebuilt path under one of `rootDir`'s roots, so a
 * record pointing anywhere else fails loudly instead of quietly retargeting the
 * remove.
 */
function ownedWorktreeDir(worktree: Worktree, repoPath: string, rootDir?: WorktreeRoots): string {
  const roots = typeof rootDir === 'string' || rootDir === undefined ? [rootDir] : rootDir
  const recorded = path.resolve(worktree.worktreePath)
  for (const root of roots) {
    const expected = worktreePathFor(repoPath, worktree.taskId, root)
    if (recorded === expected) return expected
  }
  throw new Error(
    `worktree path does not belong to task ${worktree.taskId}: ${worktree.worktreePath}`,
  )
}

/**
 * Thrown instead of replacing a checkout that may hold work found nowhere else:
 * uncommitted changes, files git ignores, a commit no branch holds, a separate
 * repository, or a folder git cannot read as a checkout, so what it holds is
 * unknown. The folder is left exactly as it was, for a person to save or remove.
 */
export class UnsafeWorktreeError extends Error {
  readonly worktreePath: string
  /** Why, in words that complete "refusing to replace <path>: ...". */
  readonly why: string
  constructor(worktreePath: string, why: string) {
    super(`refusing to replace ${worktreePath}: ${why}`)
    this.name = 'UnsafeWorktreeError'
    this.worktreePath = worktreePath
    this.why = why
  }
}

/**
 * Thrown when `git worktree list` failed, so whether the checkout at
 * `worktreePath` is registered is not known. Nothing was removed. Unlike
 * {@link UnsafeWorktreeError} this says nothing about the folder, so a caller
 * can simply try again later.
 */
export class RegistrationUnknownError extends Error {
  readonly worktreePath: string
  constructor(worktreePath: string) {
    super(`left ${worktreePath} as it is: git could not say whether it is a registered worktree`)
    this.name = 'RegistrationUnknownError'
    this.worktreePath = worktreePath
  }
}

/** Why a folder with these contents cannot be replaced, or null when it can. */
function whyNotReplaceable(contents: CheckoutContents, repoPath: string): string | null {
  switch (contents) {
    case 'missing':
    case 'empty':
    case 'clean':
      return null
    case 'dirty':
      return 'it has uncommitted changes'
    case 'ignored':
      return 'it holds files git ignores, such as an .env file, which a rebuild would delete'
    case 'unbranched':
      return 'its checked-out commit is on no branch, so removing it would lose that commit'
    case 'foreign':
      return `it is a separate git repository, not a checkout of ${repoPath}`
    case 'unreadable':
      return 'git cannot read it as a checkout, so it may hold work that is nowhere else'
  }
}

/**
 * Throw {@link UnsafeWorktreeError} unless the folder at `worktreePath` can be
 * deleted without losing anything: it is missing, empty, or a checkout of
 * `repoPath` whose commits a branch holds and whose `git status --ignored` is
 * empty. Every path that removes a task checkout in order to put another one
 * there runs this first, because the removal itself (`worktree remove
 * --force`, then a recursive delete) takes the folder's `.git` and every file
 * in it, ignored ones included.
 */
async function assertReplaceable(repoPath: string, worktreePath: string): Promise<void> {
  const why = whyNotReplaceable(await checkoutContents(repoPath, worktreePath), repoPath)
  if (why !== null) throw new UnsafeWorktreeError(worktreePath, why)
}

/** True when the checkout at `worktreePath` has `branch` checked out. */
async function isOnBranch(worktreePath: string, branch: string): Promise<boolean> {
  try {
    const head = (await execGit(worktreePath, ['symbolic-ref', '-q', 'HEAD'])).trim()
    return head === `refs/heads/${branch}`
  } catch {
    return false
  }
}

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
 *   before `worktree add`, but only a leftover that holds nothing: one with
 *   uncommitted changes, or that git cannot read, throws
 *   {@link UnsafeWorktreeError} and is left in place.
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
  const worktreePath = worktreePathFor(opts.repoPath, opts.taskId, opts.rootDir)
  // The root that gets created below is DERIVED from the pinned worktree path
  // rather than resolved a second time from the raw inputs, so the directory
  // mkdir materializes is by construction the parent of the location every
  // other operation was checked against; two independent derivations could
  // drift apart.
  const root = path.dirname(worktreePath)
  const branch = branchNameForTask(opts.taskId)

  return mutex.run(worktreePath, async () => {
    if (!(await isGitRepo(opts.repoPath))) {
      throw new Error(`not a git repository: ${opts.repoPath}`)
    }
    const branchPoint =
      opts.baseSha?.trim() || (await resolveBaseSha(opts.repoPath, opts.baseRef ?? 'HEAD'))
    await mkdir(root, { recursive: true })
    // Checked once, before either pass below: after it, anything at the path is
    // this provision's own (a failed first attempt), safe for the retry to clear.
    await assertReplaceable(opts.repoPath, worktreePath)

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
  const worktreePath = worktreePathFor(opts.repoPath, opts.taskId, opts.rootDir)
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
 *
 * A registered checkout of the task branch with no changes is kept as it is,
 * files git ignores included. Any other folder at the path is replaced only
 * when that loses nothing; otherwise this throws {@link UnsafeWorktreeError}
 * and leaves it alone. When git cannot list the repository's worktrees it
 * throws {@link RegistrationUnknownError} before touching anything.
 */
export async function resumeWorktree(opts: ResumeOptions): Promise<Worktree> {
  const worktreePath = worktreePathFor(opts.repoPath, opts.taskId, opts.rootDir)
  const branch = branchNameForTask(opts.taskId)

  return mutex.run(worktreePath, async () => {
    // Asked once, first, and that one answer decides: the replace below removes
    // the folder, which an unanswered check must never lead to.
    const registration = await worktreeRegistration(opts.repoPath, worktreePath)
    if (registration === 'unknown') throw new RegistrationUnknownError(worktreePath)
    if (!(await branchExists(opts.repoPath, branch))) {
      throw new Error(`cannot resume: branch ${branch} no longer exists`)
    }
    const contents = await checkoutContents(opts.repoPath, worktreePath)
    // Already the task's own checkout, at the branch, with nothing uncommitted:
    // re-adding it would give the same files and delete the ignored ones.
    if (
      registration === 'registered' &&
      (contents === 'clean' || contents === 'ignored') &&
      (await isOnBranch(worktreePath, branch))
    ) {
      const baseCommit = await findScaffoldCommit(opts.repoPath, branch, opts.taskId)
      return { taskId: opts.taskId, worktreePath, branch, baseCommit, detached: false }
    }
    const why = whyNotReplaceable(contents, opts.repoPath)
    if (why !== null) throw new UnsafeWorktreeError(worktreePath, why)
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
 * the worktree from the preserved branch. `rootDir` is the root, or the list of
 * roots, the record's checkout may be under; a record under none of them throws
 * before anything is touched.
 */
export async function pauseWorktree(
  repoPath: string,
  worktree: Worktree,
  rootDir?: WorktreeRoots,
): Promise<PauseResult> {
  const worktreePath = ownedWorktreeDir(worktree, repoPath, rootDir)
  return mutex.run(worktreePath, async () => {
    let committed = false
    if (
      (await isWorktreeRegistered(repoPath, worktreePath)) &&
      (await hasUncommittedChanges(worktreePath))
    ) {
      await commitAll(worktreePath, `clawboo: pause task ${worktree.taskId}`)
      committed = true
    }
    const head = committed
      ? await revParse(worktreePath, 'HEAD')
      : await revParse(repoPath, worktree.branch)
    await removeWorktree(repoPath, worktreePath) // keep the branch
    await rm(worktreePath, { recursive: true, force: true })
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
 * `in_review` and the branch awaits the verification/PR gate. `rootDir` works
 * as for {@link pauseWorktree}.
 */
export async function completeWorktree(
  repoPath: string,
  worktree: Worktree,
  rootDir?: WorktreeRoots,
): Promise<CompleteResult> {
  const worktreePath = ownedWorktreeDir(worktree, repoPath, rootDir)
  return mutex.run(worktreePath, async () => {
    const ds = await diffStat(worktreePath, worktree.baseCommit, {
      excludePaths: SOR_FILE_LIST,
    })
    if (!ds.dirty) {
      await removeWorktree(repoPath, worktreePath)
      await rm(worktreePath, { recursive: true, force: true })
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
 * worktree — the branch is kept, so nothing is lost). A folder that cannot be
 * autosaved (git does not list it, or could not answer) is reaped only when it
 * holds nothing, and skipped with a reason otherwise. Active tasks are skipped;
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
        // Commit-before-drop so reaping can never eat uncommitted work. Only a
        // checkout git lists, on a branch, can be autosaved; anything else is
        // reaped only when it holds nothing, and skipped when git could not even
        // say which it is. Files git ignores are not work: a registered
        // checkout is reaped with them, which is what keeps build output from
        // filling the disk.
        const registration = await worktreeRegistration(opts.repoPath, info.worktreePath)
        if (registration === 'unknown') {
          result.skipped.push({
            taskId: info.taskId,
            reason: 'git could not list the repository worktrees',
          })
          return false
        }
        const contents = await checkoutContents(opts.repoPath, info.worktreePath)
        const skip = (why: string): false => {
          result.skipped.push({ taskId: info.taskId, reason: `kept ${info.worktreePath}: ${why}` })
          return false
        }
        if (registration === 'registered' && contents === 'dirty') {
          if (await isDetached(info.worktreePath)) {
            return skip('it has uncommitted changes and no branch to save them on')
          }
          await commitAll(info.worktreePath, `clawboo: gc autosave task ${info.taskId}`)
        } else if (!(registration === 'registered' && contents === 'ignored')) {
          const why = whyNotReplaceable(contents, opts.repoPath)
          if (why !== null) return skip(why)
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

/** Where a repo's review worktrees live (overridable). */
function reviewRootFor(repoPath: string, rootDir?: string): string {
  return path.resolve(rootDir ?? path.join(repoPath, '.clawboo', 'reviews'))
}

/**
 * `candidate` resolved, or a thrown error unless it sits exactly one segment
 * below `reviewRoot`. Every review worktree is `<reviewRoot>/<short sha>`, and
 * both the provisioner and the teardown recursively remove that directory, so
 * the root itself, anything deeper, and anything outside are all refused.
 */
function ownedReviewDir(reviewRoot: string, candidate: string): string {
  const resolved = path.resolve(candidate)
  if (resolved === reviewRoot || path.dirname(resolved) !== reviewRoot) {
    throw new Error(`review worktree path is not inside ${reviewRoot}: ${candidate}`)
  }
  return resolved
}

/**
 * Provision a **detached** read-only reviewer worktree at a specific commit.
 * Detached HEAD = no branch, so a reviewer has nothing to push: review can never
 * mutate a teammate's branch. (Tool-level write denial is the runtime's job —
 * e.g. an OpenClaw read-only sandbox; this gives the structural guarantee.)
 */
export async function provisionReviewWorktree(opts: ReviewOptions): Promise<Worktree> {
  const reviewRoot = reviewRootFor(opts.repoPath, opts.rootDir)
  const worktreePath = ownedReviewDir(reviewRoot, path.join(reviewRoot, opts.sha.slice(0, 12)))

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

/**
 * Tear down a review worktree (no branch to delete: it was detached). Pass the
 * same `rootDir` the worktree was provisioned with: a path that is not directly
 * under that root throws before anything is removed.
 */
export async function removeReviewWorktree(
  repoPath: string,
  worktree: Worktree,
  rootDir?: string,
): Promise<void> {
  const worktreePath = ownedReviewDir(reviewRootFor(repoPath, rootDir), worktree.worktreePath)
  await mutex.run(worktreePath, async () => {
    await removeWorktree(repoPath, worktreePath)
    await rm(worktreePath, { recursive: true, force: true })
  })
}
