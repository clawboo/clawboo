// Shared test harness: spins up real throwaway git repos in the OS temp dir so
// the worktree lifecycle is exercised against actual `git`, not a mock. NOT a
// test file itself (no `.test.ts` suffix) — imported by the suites.
//
// Uses `execFile` (array args, no shell) — the injection-safe spawn form, the
// same one the package and the rest of the server use.

import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import type { TaskScaffoldInput } from '../types'

const execFileAsync = promisify(execFile)

export async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true })
  return stdout
}

/** Create a fresh git repo with one initial commit on `main`. */
export async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-wt-repo-'))
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(dir, 'README.md'), '# repo\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--no-verify', '-m', 'init'])
  return dir
}

export async function cleanup(...dirs: string[]): Promise<void> {
  for (const d of dirs) await rm(d, { recursive: true, force: true })
}

export function scaffoldInput(taskId = 't1'): TaskScaffoldInput {
  return {
    taskId,
    title: 'Add feature X',
    description: 'Implement feature X end to end.',
    acceptanceCriteria: ['Feature X works', 'Tests pass'],
    commands: { install: 'echo install', verify: 'echo verify', start: 'echo start' },
  }
}
