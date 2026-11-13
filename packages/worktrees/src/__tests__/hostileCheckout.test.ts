// What a repository or checkout an agent controls can do to the lifecycle: make
// git print something other than a commit id where one is expected, hide its
// untracked files through config, or lose its registration. And the two
// options the server uses for agents on their own OS user: keep a task branch's
// commits on a fresh provision, and leave the repository's registrations alone.

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  checkoutContents,
  diffStat,
  findScaffoldCommit,
  GitError,
  hasUncommittedChanges,
  revParse,
} from '../git'
import { localWorktreeIo, setWorktreeIo, type WorktreeIo } from '../io'
import {
  gcWorktrees,
  loadWorktree,
  pauseWorktree,
  provisionWorktree,
  RegistrationUnknownError,
  UnsafeWorktreeError,
} from '../lifecycle'
import { SOR_FILES } from '../scaffold'
import { cleanup, git, initRepo, scaffoldInput } from './gitHarness'

/** The local io, with git answering `answer` where it returns a string. */
function gitWith(answer: (args: string[]) => string | undefined, seen?: string[][]): WorktreeIo {
  return {
    ...localWorktreeIo,
    git: async (cwd, args) => {
      seen?.push(args)
      const forged = answer(args)
      return forged !== undefined ? forged : localWorktreeIo.git(cwd, args)
    },
  }
}

let repo: string
let root: string

beforeEach(async () => {
  repo = await initRepo()
  // By its real path: git lists checkouts that way (`/private/var` on macOS).
  root = await realpath(await mkdtemp(path.join(os.tmpdir(), 'clawboo-hostile-')))
})

afterEach(async () => {
  setWorktreeIo(null)
  await cleanup(repo, root)
})

describe('git output that is not a commit id never goes back to git', () => {
  it('the scaffold commit is read with signature checks off, and only a commit id is taken', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 's1',
      rootDir: root,
      scaffold: scaffoldInput('s1'),
    })
    const seen: string[][] = []
    setWorktreeIo(gitWith(() => undefined, seen))
    expect(await findScaffoldCommit(repo, wt.branch, 's1')).toBe(wt.baseCommit)
    expect(seen[0]?.slice(0, 3)).toEqual(['-c', 'log.showSignature=false', 'log'])
  })

  it('a log line that is not a commit id is refused, never used as the baseline', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 's1',
      rootDir: root,
      scaffold: scaffoldInput('s1'),
    })
    // What a `gpg.program` of the repository's choosing can put before the id.
    const victim = path.join(root, 'victim')
    await writeFile(victim, 'keep me\n')
    setWorktreeIo(
      gitWith((args) =>
        args.includes('log') ? `--output=${victim}\n${wt.baseCommit}\n` : undefined,
      ),
    )
    await expect(findScaffoldCommit(repo, wt.branch, 's1')).rejects.toBeInstanceOf(GitError)
    await expect(loadWorktree({ repoPath: repo, taskId: 's1', rootDir: root })).rejects.toThrow(
      /no scaffold commit id/,
    )
    expect(await readFile(victim, 'utf8')).toBe('keep me\n')
  })

  it('rev-parse must print a commit id', async () => {
    setWorktreeIo(gitWith((args) => (args[0] === 'rev-parse' ? '--output=/tmp/x\n' : undefined)))
    await expect(revParse(repo)).rejects.toThrow(/did not print a commit id/)
  })
})

describe('a checkout whose config hides untracked files', () => {
  it('still counts them: uncommitted, dirty, and in the diff', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'u1',
      rootDir: root,
      scaffold: scaffoldInput('u1'),
    })
    await git(wt.worktreePath, ['config', 'status.showUntrackedFiles', 'no'])
    await writeFile(path.join(wt.worktreePath, 'work.txt'), 'only copy\n')
    expect(await hasUncommittedChanges(wt.worktreePath)).toBe(true)
    expect(await checkoutContents(repo, wt.worktreePath)).toBe('dirty')
    const ds = await diffStat(wt.worktreePath, wt.baseCommit, {
      excludePaths: Object.values(SOR_FILES),
    })
    expect(ds).toMatchObject({ filesChanged: 1, dirty: true })
  })
})

describe('pause never removes a checkout it could not commit', () => {
  it('stops when git cannot say whether the checkout is registered', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'p1',
      rootDir: root,
      scaffold: scaffoldInput('p1'),
    })
    await writeFile(path.join(wt.worktreePath, 'work.txt'), 'only copy\n')
    setWorktreeIo(
      gitWith((args) => {
        if (args[0] === 'worktree' && args[1] === 'list') {
          throw new GitError('git worktree list failed: timed out', args, 'timed out')
        }
        return undefined
      }),
    )
    await expect(pauseWorktree(repo, wt, root)).rejects.toBeInstanceOf(RegistrationUnknownError)
    setWorktreeIo(null)
    expect(await readFile(path.join(wt.worktreePath, 'work.txt'), 'utf8')).toBe('only copy\n')
  })

  it('refuses a folder git no longer lists when it holds anything', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'p2',
      rootDir: root,
      scaffold: scaffoldInput('p2'),
    })
    await writeFile(path.join(wt.worktreePath, 'work.txt'), 'only copy\n')
    // Its registration is lost: the admin folder in the repository is gone.
    await rm(path.join(repo, '.git', 'worktrees', path.basename(wt.worktreePath)), {
      recursive: true,
      force: true,
    })
    await expect(pauseWorktree(repo, wt, root)).rejects.toBeInstanceOf(UnsafeWorktreeError)
    expect(await readFile(path.join(wt.worktreePath, 'work.txt'), 'utf8')).toBe('only copy\n')
  })

  it('still pauses a registered checkout, and a missing one', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'p3',
      rootDir: root,
      scaffold: scaffoldInput('p3'),
    })
    await writeFile(path.join(wt.worktreePath, 'work.txt'), 'saved\n')
    expect((await pauseWorktree(repo, wt, root)).committed).toBe(true)
    expect(existsSync(wt.worktreePath)).toBe(false)
    expect(await git(repo, ['show', `${wt.branch}:work.txt`])).toBe('saved\n')
    // Paused again: nothing there, nothing to lose.
    expect((await pauseWorktree(repo, wt, root)).committed).toBe(false)
  })
})

describe('a fresh provision that keeps the branch commits', () => {
  it('refuses to reset a branch with commits past the branch point', async () => {
    const base = await revParse(repo)
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'k1',
      rootDir: root,
      scaffold: scaffoldInput('k1'),
    })
    await writeFile(path.join(wt.worktreePath, 'work.txt'), 'committed work\n')
    await pauseWorktree(repo, wt, root)
    const tip = await revParse(repo, wt.branch)

    const again = provisionWorktree({
      repoPath: repo,
      taskId: 'k1',
      baseSha: base,
      rootDir: root,
      scaffold: scaffoldInput('k1'),
      keepBranchCommits: true,
    })
    await expect(again).rejects.toBeInstanceOf(UnsafeWorktreeError)
    await expect(again).rejects.toThrow(/commits after the commit the task would start from/)
    expect(await revParse(repo, wt.branch)).toBe(tip)
  })

  it('moves a branch forward when that drops nothing', async () => {
    const base = await revParse(repo)
    await git(repo, ['branch', 'clawboo/task-k2', base])
    await writeFile(path.join(repo, 'later.txt'), 'later\n')
    await git(repo, ['add', '-A'])
    await git(repo, ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-q', '-m', 'later'])
    const later = await revParse(repo)
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'k2',
      baseSha: later,
      rootDir: root,
      scaffold: scaffoldInput('k2'),
      keepBranchCommits: true,
    })
    expect(await revParse(repo, `${wt.baseCommit}^`)).toBe(later)
  })
})

describe('leaving the repository registrations alone', () => {
  /** Another checkout of the repository, whose folder is gone for now: a
   *  prune would drop its registration. */
  /** A path as `git worktree list` prints it: forward slashes, even on Windows. */
  const asGit = (p: string): string => p.split(path.sep).join('/')

  async function elsewhere(name: string): Promise<string> {
    const other = path.join(root, name)
    await git(repo, ['worktree', 'add', '-q', '-b', name, other])
    await rm(other, { recursive: true, force: true })
    return other
  }

  it('GC and pause with prune off remove only their own checkout', async () => {
    const wts = path.join(root, 'wts')
    const a = await provisionWorktree({
      repoPath: repo,
      taskId: 'g1',
      rootDir: wts,
      scaffold: scaffoldInput('g1'),
    })
    const other = await elsewhere('other-1')
    const r = await gcWorktrees({ repoPath: repo, rootDir: wts, maxCount: 0, prune: false })
    expect(r.reaped).toEqual(['g1'])
    expect(existsSync(a.worktreePath)).toBe(false)
    expect(await git(repo, ['worktree', 'list', '--porcelain'])).toContain(asGit(other))

    const b = await provisionWorktree({
      repoPath: repo,
      taskId: 'g2',
      rootDir: wts,
      scaffold: scaffoldInput('g2'),
    })
    const another = await elsewhere('other-2')
    await pauseWorktree(repo, b, wts, { prune: false })
    const listed = await git(repo, ['worktree', 'list', '--porcelain'])
    expect(listed).toContain(asGit(another))
    expect(listed).not.toContain(asGit(b.worktreePath))
  })
})
