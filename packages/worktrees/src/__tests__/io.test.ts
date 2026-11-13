// The io seam: every git call and file operation of the lifecycle, the scaffold,
// the task files and the relocation goes through the installed `WorktreeIo`, and
// the default one behaves as the package always did.

import { existsSync } from 'node:fs'
import { mkdtemp, readFile, stat } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { execGit, GitError, isGitRepo, revParse } from '../git'
import { readHandoff, writeHandoff } from '../handoff'
import { getWorktreeIo, localWorktreeIo, setWorktreeIo, type WorktreeIo } from '../io'
import {
  completeWorktree,
  gcWorktrees,
  pauseWorktree,
  provisionReviewWorktree,
  provisionWorktree,
  removeReviewWorktree,
  resumeWorktree,
} from '../lifecycle'
import { relocateWorktree } from '../relocate'
import { SOR_FILES, writeScaffold } from '../scaffold'
import { appendTaskFile, readTaskFile } from '../taskFiles'
import { cleanup, git, initRepo, scaffoldInput } from './gitHarness'

type Call = { op: keyof WorktreeIo; args: unknown[] }

/** An io that records every call and then runs it here. */
function recordingIo(calls: Call[]): WorktreeIo {
  const io = {} as Record<keyof WorktreeIo, (...a: unknown[]) => unknown>
  for (const op of Object.keys(localWorktreeIo) as (keyof WorktreeIo)[]) {
    io[op] = (...args: unknown[]) => {
      calls.push({ op, args })
      return (localWorktreeIo[op] as (...a: unknown[]) => unknown)(...args)
    }
  }
  return io as unknown as WorktreeIo
}

const gitCalls = (calls: Call[]): string[][] =>
  calls.filter((c) => c.op === 'git').map((c) => c.args[1] as string[])

afterEach(() => {
  setWorktreeIo(null)
})

describe('the default io', () => {
  it('is the local one, and setting null goes back to it', () => {
    expect(getWorktreeIo()).toBe(localWorktreeIo)
    setWorktreeIo(recordingIo([]))
    expect(getWorktreeIo()).not.toBe(localWorktreeIo)
    setWorktreeIo(null)
    expect(getWorktreeIo()).toBe(localWorktreeIo)
  })

  it('keeps the errors callers rely on: GitError with stderr, ENOENT for a missing task file', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-io-'))
    try {
      const err = await execGit(dir, ['rev-parse', 'HEAD']).catch((e: unknown) => e)
      expect(err).toBeInstanceOf(GitError)
      expect((err as GitError).args).toEqual(['rev-parse', 'HEAD'])
      expect((err as GitError).stderr).toMatch(/not a git repository/i)
      await expect(readTaskFile(dir, SOR_FILES.handoff)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await cleanup(dir)
    }
  })
})

describe('everything goes through the installed io', () => {
  let repo: string
  let root: string
  let calls: Call[]

  beforeEach(async () => {
    repo = await initRepo()
    root = await mkdtemp(path.join(os.tmpdir(), 'clawboo-io-root-'))
    calls = []
    setWorktreeIo(recordingIo(calls))
  })

  afterEach(async () => {
    setWorktreeIo(null)
    await cleanup(repo, root)
  })

  it('provision, pause, resume and complete: git, folders, scaffold writes and reads', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'io1',
      rootDir: root,
      scaffold: scaffoldInput('io1'),
    })
    const ops = new Set(calls.map((c) => c.op))
    for (const op of [
      'git',
      'mkdir',
      'rm',
      'exists',
      'readdir',
      'realpath',
      'writeFile',
    ] as const) {
      expect(ops.has(op), op).toBe(true)
    }
    expect(gitCalls(calls)).toContainEqual(
      expect.arrayContaining(['worktree', 'add', '-b', 'clawboo/task-io1', wt.worktreePath]),
    )
    // The scaffold: five files, init.sh executable, all written through the io.
    const writes = calls.filter((c) => c.op === 'writeFile')
    expect(writes.map((c) => path.basename(c.args[0] as string)).sort()).toEqual(
      [
        SOR_FILES.task,
        SOR_FILES.progress,
        SOR_FILES.decisions,
        SOR_FILES.init,
        SOR_FILES.verification,
      ].sort(),
    )
    expect(writes.find((c) => (c.args[0] as string).endsWith(SOR_FILES.init))?.args[2]).toBe(0o755)
    if (process.platform !== 'win32') {
      expect((await stat(path.join(wt.worktreePath, SOR_FILES.init))).mode & 0o777).toBe(0o755)
    }

    calls.length = 0
    await writeHandoff(wt.worktreePath, {
      handoffFrom: 'a',
      runtime: 'codex',
      completedSubtasks: [],
      brokenOrUnverified: [],
      nextBestStep: '',
      commands: { init: './init.sh', verify: '', start: '' },
      evidence: {},
      warnings: [],
    })
    expect((await readHandoff(wt.worktreePath))?.handoffFrom).toBe('a')
    await appendTaskFile(wt.worktreePath, SOR_FILES.verification, '\nevidence\n')
    expect(calls.map((c) => c.op)).toEqual(['replaceTaskFile', 'readTaskFile', 'appendTaskFile'])

    calls.length = 0
    await pauseWorktree(repo, wt, root)
    expect(existsSync(wt.worktreePath)).toBe(false)
    expect(calls.some((c) => c.op === 'rm' && c.args[0] === wt.worktreePath)).toBe(true)
    expect(gitCalls(calls)).toContainEqual(['worktree', 'remove', '--force', wt.worktreePath])

    calls.length = 0
    const resumed = await resumeWorktree({ repoPath: repo, taskId: 'io1', rootDir: root })
    expect(gitCalls(calls)).toContainEqual(['worktree', 'add', wt.worktreePath, wt.branch])

    calls.length = 0
    const done = await completeWorktree(repo, resumed, root)
    expect(done.cleaned).toBe(true)
    expect(gitCalls(calls)).toContainEqual(['branch', '-D', wt.branch])
    expect(calls.some((c) => c.op === 'rm' && c.args[0] === wt.worktreePath)).toBe(true)
  })

  it('GC lists the root and reads ages through the io', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'io2',
      rootDir: root,
      scaffold: scaffoldInput('io2'),
    })
    calls.length = 0
    const r = await gcWorktrees({ repoPath: repo, rootDir: root, maxCount: 0, now: Date.now() })
    expect(r.reaped).toEqual(['io2'])
    expect(calls.some((c) => c.op === 'readdir' && c.args[0] === root)).toBe(true)
    expect(calls.some((c) => c.op === 'stat' && c.args[0] === wt.worktreePath)).toBe(true)
    expect(calls.some((c) => c.op === 'rm' && c.args[0] === wt.worktreePath)).toBe(true)
  })

  it('a review checkout and a relocation run their git and folder work through the io', async () => {
    const sha = await revParse(repo)
    const reviews = path.join(root, 'reviews')
    const review = await provisionReviewWorktree({ repoPath: repo, sha, rootDir: reviews })
    expect(calls.some((c) => c.op === 'mkdir' && c.args[0] === path.resolve(reviews))).toBe(true)
    expect(gitCalls(calls)).toContainEqual([
      'worktree',
      'add',
      '--detach',
      review.worktreePath,
      sha,
    ])
    calls.length = 0
    await removeReviewWorktree(repo, review, reviews)
    expect(calls.some((c) => c.op === 'rm' && c.args[0] === review.worktreePath)).toBe(true)

    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'io3',
      rootDir: root,
      scaffold: scaffoldInput('io3'),
    })
    calls.length = 0
    const to = path.join(root, 'moved')
    expect(await relocateWorktree(repo, wt.worktreePath, to)).toEqual({ ok: true, via: 'move' })
    expect(gitCalls(calls)).toEqual([['worktree', 'move', wt.worktreePath, to]])
  })
})

describe('an io that runs nothing here', () => {
  it('answers git, and the scaffold and task files never touch the disk themselves', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-io-fake-'))
    const written: string[] = []
    const fake: WorktreeIo = {
      ...localWorktreeIo,
      git: async (_cwd, args) =>
        args.includes('--is-inside-work-tree')
          ? 'true\n'
          : args[0] === 'rev-parse'
            ? 'f'.repeat(40) + '\n'
            : '',
      writeFile: async (file) => {
        written.push(path.basename(file))
      },
      readTaskFile: async (_dir, name) => `from the io: ${name}`,
      appendTaskFile: async () => undefined,
    }
    setWorktreeIo(fake)
    try {
      // Not a repository on disk, but the io says it is.
      expect(await isGitRepo(dir)).toBe(true)
      expect(await revParse(dir)).toBe('f'.repeat(40))
      await writeScaffold(dir, scaffoldInput('fake'))
      expect(written).toHaveLength(5)
      expect(existsSync(path.join(dir, SOR_FILES.task))).toBe(false)
      expect(await readTaskFile(dir, SOR_FILES.progress)).toBe(`from the io: ${SOR_FILES.progress}`)
      await appendTaskFile(dir, SOR_FILES.verification, 'x')
      expect(existsSync(path.join(dir, SOR_FILES.verification))).toBe(false)
      // A name that is not one plain segment is refused before the io is asked.
      await expect(readTaskFile(dir, '../escape')).rejects.toThrow(/not a file name/)
    } finally {
      setWorktreeIo(null)
      await cleanup(dir)
    }
  })

  it('a git failure the io reports is what callers see', async () => {
    const repo = await initRepo()
    try {
      setWorktreeIo({
        ...localWorktreeIo,
        git: async (_cwd, args) => {
          throw new GitError(`git ${args.join(' ')} failed: refused`, args, 'refused')
        },
      })
      // A real repository on disk, but every git call is refused by the io.
      expect(await isGitRepo(repo)).toBe(false)
      await expect(
        provisionWorktree({ repoPath: repo, taskId: 'r1', scaffold: scaffoldInput('r1') }),
      ).rejects.toThrow(/not a git repository/)
      setWorktreeIo(null)
      expect(await git(repo, ['worktree', 'list', '--porcelain'])).not.toContain('task-r1')
      expect(await readFile(path.join(repo, 'README.md'), 'utf8')).toBe('# repo\n')
    } finally {
      setWorktreeIo(null)
      await cleanup(repo)
    }
  })
})
