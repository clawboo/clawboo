// Low-level git plumbing for the worktree lifecycle. We shell out to the `git`
// CLI (not a libgit2 binding): the CLI is the most robust path for mutable
// worktree operations and matches what every shipping worktree harness does.
// All spawns use `windowsHide` + a timeout so a hung git can't wedge the
// single-threaded server event loop.

import { execFile } from 'node:child_process'
import { realpath } from 'node:fs/promises'
import { promisify } from 'node:util'
import path from 'node:path'

import type { DiffStat } from './types'

const execFileAsync = promisify(execFile)

const GIT_TIMEOUT_MS = 60_000
const GIT_MAX_BUFFER = 32 * 1024 * 1024 // 32 MiB — large diffs/log output

export class GitError extends Error {
  readonly stderr: string
  readonly args: string[]
  constructor(message: string, args: string[], stderr: string) {
    super(message)
    this.name = 'GitError'
    this.args = args
    this.stderr = stderr
  }
}

/**
 * Run `git <args>` in `cwd`. Throws `GitError` (with stderr) on non-zero exit.
 * `windowsHide` suppresses the console popup on Windows; the timeout bounds a
 * hung invocation so it can't block the event loop forever.
 */
export async function execGit(cwd: string, args: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: GIT_MAX_BUFFER,
      encoding: 'utf8',
    })
    return stdout
  } catch (err) {
    const e = err as { stderr?: string; stdout?: string; message?: string }
    const stderr = (e.stderr ?? e.stdout ?? e.message ?? '').toString()
    throw new GitError(`git ${args.join(' ')} failed: ${stderr.trim()}`, args, stderr)
  }
}

/** True when `dir` is inside a git work tree. */
export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    const out = await execGit(dir, ['rev-parse', '--is-inside-work-tree'])
    return out.trim() === 'true'
  } catch {
    return false
  }
}

/** Resolve a ref (default HEAD) to a full commit SHA. */
export async function resolveBaseSha(repoPath: string, ref = 'HEAD'): Promise<string> {
  return (await execGit(repoPath, ['rev-parse', ref])).trim()
}

/** Resolve the current HEAD commit of a worktree. */
export async function revParse(dir: string, ref = 'HEAD'): Promise<string> {
  return (await execGit(dir, ['rev-parse', ref])).trim()
}

/** True when a local branch exists. */
export async function branchExists(repoPath: string, branch: string): Promise<boolean> {
  try {
    await execGit(repoPath, ['show-ref', '--verify', '--quiet', `refs/heads/${branch}`])
    return true
  } catch {
    return false
  }
}

/** The default branch name for a task's worktree. */
export function branchNameForTask(taskId: string): string {
  return `clawboo/task-${taskId}`
}

/** Where a repo's clawboo worktrees live (overridable). */
export function worktreeRootFor(repoPath: string, rootDir?: string): string {
  return rootDir ?? path.join(repoPath, '.clawboo', 'worktrees')
}

/**
 * `git worktree add <args>`. Pass the full arg list after `add` in git's order:
 * `[-b|-B <branch>] <path> [<commit-ish>]` (the path comes BEFORE the commit-ish).
 */
export async function addWorktree(repoPath: string, args: string[]): Promise<void> {
  await execGit(repoPath, ['worktree', 'add', ...args])
}

/** Force-remove a worktree registration (no error if absent), then prune. */
export async function removeWorktree(repoPath: string, worktreePath: string): Promise<void> {
  try {
    await execGit(repoPath, ['worktree', 'remove', '--force', worktreePath])
  } catch {
    // The worktree may already be gone / never registered — prune cleans it up.
  }
  await pruneWorktrees(repoPath)
}

export async function pruneWorktrees(repoPath: string): Promise<void> {
  try {
    await execGit(repoPath, ['worktree', 'prune'])
  } catch {
    // best-effort
  }
}

/** Delete a local branch (force). Best-effort. */
export async function deleteBranch(repoPath: string, branch: string): Promise<void> {
  try {
    await execGit(repoPath, ['branch', '-D', branch])
  } catch {
    // branch may not exist / be checked out elsewhere — caller has already
    // removed the worktree, so this is best-effort cleanup.
  }
}

/** `git worktree list --porcelain` parsed into absolute worktree paths. */
export async function listWorktreePaths(repoPath: string): Promise<string[]> {
  const out = await execGit(repoPath, ['worktree', 'list', '--porcelain'])
  return out
    .split('\n')
    .filter((l) => l.startsWith('worktree '))
    .map((l) => l.slice('worktree '.length).trim())
}

/**
 * Canonicalize a path through symlinks. `git worktree list` reports realpaths
 * (e.g. macOS resolves `/var/…` → `/private/var/…`), while a caller's path may
 * still be the symlinked form — so compare realpaths, not just `path.resolve`.
 */
async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return path.resolve(p)
  }
}

/** True when `worktreePath` is registered as a git worktree of `repoPath`. */
export async function isWorktreeRegistered(
  repoPath: string,
  worktreePath: string,
): Promise<boolean> {
  try {
    const paths = await listWorktreePaths(repoPath)
    const target = await canonical(worktreePath)
    const resolved = await Promise.all(paths.map(canonical))
    return resolved.includes(target)
  } catch {
    return false
  }
}

/** True when the working tree has any uncommitted change (incl. untracked). */
export async function hasUncommittedChanges(worktreePath: string): Promise<boolean> {
  const out = await execGit(worktreePath, ['status', '--porcelain'])
  return out.trim().length > 0
}

/**
 * Stage everything and commit. Skips hooks (`--no-verify`) for WIP/auto-saves,
 * and injects a clawboo committer identity via `-c` so a baseline/auto commit
 * works even in a repo (or CI worktree) with no configured `user.name/email`.
 */
export async function commitAll(worktreePath: string, message: string): Promise<void> {
  await execGit(worktreePath, ['add', '-A'])
  await execGit(worktreePath, [
    '-c',
    'user.name=clawboo',
    '-c',
    'user.email=clawboo@localhost',
    'commit',
    '--no-verify',
    '-m',
    message,
  ])
}

/** Find the SoR-scaffold baseline commit on a branch (recovers the diff baseline). */
export async function findScaffoldCommit(
  repoPath: string,
  branch: string,
  taskId: string,
): Promise<string> {
  const out = await execGit(repoPath, [
    'log',
    '--format=%H',
    '--grep',
    `clawboo: scaffold task ${taskId}`,
    '-n',
    '1',
    branch,
  ])
  const sha = out.trim().split('\n')[0] ?? ''
  if (!sha) throw new GitError(`no scaffold commit on ${branch}`, ['log'], '')
  return sha
}

/**
 * Diff stat of a worktree relative to its baseline commit. Counts the committed
 * delta (baseline → working tree) plus untracked files, so it answers "did any
 * real work happen here?" precisely:
 *   - clean working tree at the baseline commit → `dirty:false` (auto-cleanup ok)
 *   - any committed delta, uncommitted edit, or untracked file → `dirty:true`
 *
 * `excludePaths` (worktree-root-relative) are NOT counted — they are the
 * system-of-record bookkeeping files (the handoff, progress, decisions, …),
 * which clawboo writes/updates itself; they are not the agent's deliverable, so
 * a worktree that only changed them is still an "empty" result.
 */
export async function diffStat(
  worktreePath: string,
  baseCommit: string,
  opts: { excludePaths?: string[] } = {},
): Promise<DiffStat> {
  const exclude = opts.excludePaths ?? []
  const pathspec = exclude.length ? ['--', '.', ...exclude.map((p) => `:(exclude)${p}`)] : []
  // `git diff --numstat <baseCommit> [-- . :(exclude)…]` = baseline vs working
  // tree (committed + uncommitted tracked changes), minus the SoR files.
  // Untracked files don't appear here, so we count them from porcelain status.
  const numstat = await execGit(worktreePath, ['diff', '--numstat', baseCommit, ...pathspec])
  let filesChanged = 0
  let insertions = 0
  let deletions = 0
  for (const line of numstat.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [add, del] = trimmed.split('\t')
    filesChanged += 1
    // Binary files show "-" for counts; treat as 0 added/removed lines.
    insertions += add === '-' ? 0 : Number(add) || 0
    deletions += del === '-' ? 0 : Number(del) || 0
  }
  const status = await execGit(worktreePath, ['status', '--porcelain'])
  const excludeSet = new Set(exclude)
  const untracked = status
    .split('\n')
    .filter((l) => l.startsWith('??'))
    .map((l) => l.slice(3).trim())
    .filter((p) => !excludeSet.has(p)).length
  filesChanged += untracked
  return { filesChanged, insertions, deletions, dirty: filesChanged > 0 }
}

/**
 * The unified diff text (baseline vs working tree), for read-only display in the
 * task-detail drawer. `excludePaths` (worktree-root-relative) are dropped — the
 * SoR bookkeeping files are clawboo's, not the agent's deliverable.
 */
export async function worktreeDiff(
  worktreePath: string,
  baseCommit: string,
  opts: { excludePaths?: string[] } = {},
): Promise<string> {
  const exclude = opts.excludePaths ?? []
  const pathspec = exclude.length ? ['--', '.', ...exclude.map((p) => `:(exclude)${p}`)] : []
  return execGit(worktreePath, ['diff', baseCommit, ...pathspec])
}

/** True when HEAD is detached (no branch) — the read-only reviewer guarantee. */
export async function isDetached(worktreePath: string): Promise<boolean> {
  try {
    await execGit(worktreePath, ['symbolic-ref', '-q', 'HEAD'])
    return false // symbolic-ref succeeds ⇒ on a branch
  } catch {
    return true // non-zero ⇒ detached HEAD
  }
}

/**
 * Per-key async mutex: serializes operations that share a key (a worktree path)
 * so concurrent provision/remove calls can't race on the same checkout. A
 * failed op does NOT poison the chain — the next queued op still runs.
 */
export class KeyedMutex {
  private chains = new Map<string, Promise<unknown>>()

  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.chains.get(key) ?? Promise.resolve()
    // `prev.then(fn, fn)` runs `fn` whether the previous op resolved or rejected.
    const result = prev.then(fn, fn) as Promise<T>
    const tail = result.then(
      () => undefined,
      () => undefined,
    )
    this.chains.set(key, tail)
    void tail.then(() => {
      if (this.chains.get(key) === tail) this.chains.delete(key)
    })
    return result
  }
}
