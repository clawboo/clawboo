// Resume asks git whether the checkout is registered before it decides to keep
// or replace it. When `git worktree list` fails, that answer is "unknown", which
// says nothing about the folder, so resume must stop before it removes anything
// and say why. The probe is wrapped here so it can fail on its own while every
// other git call runs for real.

import { stat, writeFile } from 'node:fs/promises'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// `vi.mock` is hoisted above these, so they see the wrapped probe.
import { commitAll } from '../git'
import { RegistrationUnknownError, provisionWorktree, resumeWorktree } from '../lifecycle'
import { cleanup, initRepo, scaffoldInput } from './gitHarness'

const probe = vi.hoisted(() => ({ failing: false }))

vi.mock('../git', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../git')>()
  return {
    ...actual,
    worktreeRegistration: async (repo: string, wt: string) =>
      probe.failing ? ('unknown' as const) : actual.worktreeRegistration(repo, wt),
  }
})

describe('resume when git cannot say whether the checkout is registered', () => {
  let repo: string
  beforeEach(async () => {
    probe.failing = false
    repo = await initRepo()
  })
  afterEach(async () => {
    probe.failing = false
    await cleanup(repo)
  })

  it('stops before removing a clean checkout, and leaves it exactly as it was', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'u1',
      scaffold: scaffoldInput('u1'),
    })
    const taskFile = path.join(wt.worktreePath, 'TASK.md')
    const before = (await stat(taskFile)).ino
    probe.failing = true

    const attempt = resumeWorktree({ repoPath: repo, taskId: 'u1' })
    await expect(attempt).rejects.toBeInstanceOf(RegistrationUnknownError)
    await expect(attempt).rejects.toThrow(wt.worktreePath)
    // Same file, not a fresh checkout of it.
    expect((await stat(taskFile)).ino).toBe(before)
  })

  it('reports the unanswered check, not unsafe contents, for a checkout with ignored files', async () => {
    const wt = await provisionWorktree({
      repoPath: repo,
      taskId: 'u2',
      scaffold: scaffoldInput('u2'),
    })
    await writeFile(path.join(wt.worktreePath, '.gitignore'), '.env\n')
    await commitAll(wt.worktreePath, 'ignore .env')
    await writeFile(path.join(wt.worktreePath, '.env'), 'API_KEY=kept\n')
    probe.failing = true

    await expect(resumeWorktree({ repoPath: repo, taskId: 'u2' })).rejects.toBeInstanceOf(
      RegistrationUnknownError,
    )
  })
})
