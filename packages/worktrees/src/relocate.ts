// Moving a task checkout to another folder without breaking git's two links to
// it: `.git/worktrees/<name>/gitdir` in the repository and the `.git` file in
// the checkout. Both hold absolute paths, so a folder renamed on its own loses
// its admin folder to the next `git worktree prune`, which clawboo runs often.
//
// `git worktree move` renames the folder and fixes both links. It refuses a
// locked checkout and one with submodules; for those the folder is renamed and
// `git worktree repair` (git 2.30 and later) rewrites the links. Either way the
// caller checks the result with {@link isCheckoutAt} before it relies on it.
// Renames only: a move across volumes fails with `EXDEV` and changes nothing.

import { existsSync } from 'node:fs'
import { realpath, rename } from 'node:fs/promises'
import path from 'node:path'

import { execGit, listWorktreePaths } from './git'

export type RelocateResult =
  | { ok: true; via: 'move' | 'repair' }
  /** Nothing moved. `code` is the rename's error code (`EXDEV` across volumes). */
  | { ok: false; reason: string; code?: string }

/**
 * Move the checkout of `repoPath` at `from` to `to`, which must not exist yet
 * (its parent must). Nothing is copied: on failure the folder is where it was.
 */
export async function relocateWorktree(
  repoPath: string,
  from: string,
  to: string,
): Promise<RelocateResult> {
  try {
    await execGit(repoPath, ['worktree', 'move', from, to])
    return { ok: true, via: 'move' }
  } catch (moveErr) {
    // git renames first and fixes the links after, so a failure in between
    // leaves the folder at `to`; repair finishes that one too.
    if (!existsSync(to)) {
      try {
        await rename(from, to)
      } catch (err) {
        const code = (err as NodeJS.ErrnoException).code
        return {
          ok: false,
          reason: `git worktree move failed (${String(moveErr)}) and so did a rename: ${String(err)}`,
          ...(code ? { code } : {}),
        }
      }
    }
    try {
      await execGit(repoPath, ['worktree', 'repair', to])
    } catch {
      // The caller's check decides; a failed repair reads as not moved there.
    }
    return { ok: true, via: 'repair' }
  }
}

async function canonical(p: string): Promise<string> {
  try {
    return await realpath(p)
  } catch {
    return path.resolve(p)
  }
}

/** `p` with the links in its parent folders resolved but not one at `p` itself,
 *  so two spellings of a folder compare equal and a link never stands in for
 *  the folder it points to. */
async function leafCanonical(p: string): Promise<string> {
  const resolved = path.resolve(p)
  return path.join(await canonical(path.dirname(resolved)), path.basename(resolved))
}

/**
 * True when `dir` is a working checkout of `repoPath` that git lists AT `dir`:
 * git run in it finds `dir` itself as the top level (not an enclosing
 * repository), and `git worktree list` names that very path. A listed path
 * that is a link to `dir` does not count: after a move, the old path is often
 * one, and git still listing the old path means its links were not fixed, so
 * the next prune that finds the link gone would drop the checkout's admin
 * folder.
 */
export async function isCheckoutAt(repoPath: string, dir: string): Promise<boolean> {
  try {
    const top = (await execGit(dir, ['rev-parse', '--show-toplevel'])).trim()
    if ((await canonical(top)) !== (await canonical(dir))) return false
  } catch {
    return false
  }
  let listed: string[]
  try {
    listed = await listWorktreePaths(repoPath)
  } catch {
    return false
  }
  const target = await leafCanonical(dir)
  for (const p of listed) if ((await leafCanonical(p)) === target) return true
  return false
}
