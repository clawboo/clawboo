// A person finishes a task while its check runs, then reopens it. The check is the
// real gate against a real git worktree; the only thing added is what the person does,
// landed inside `verifyTask` exactly when a slow check would see it. Nothing from the
// old check may move the reopened task, start a fix run on it, or finish a newer run.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  claimTask,
  createExecutionProcess,
  createTask,
  getTask,
  getTaskVerification,
  reopenTask,
  setTaskVerification,
  updateStatus,
} from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** What happens while the check runs. */
const during = vi.hoisted(() => ({ act: null as ((taskId: string) => void) | null }))

vi.mock('../verification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../verification')>()
  return {
    ...actual,
    verifyTask: async (input: Parameters<typeof actual.verifyTask>[0]) => {
      during.act?.(input.taskId)
      return actual.verifyTask(input)
    },
  }
})

const { getDb, getDbPath, resetDb } = await import('../db')
const { actOnTaskWorkspace, provisionTaskWorkspace } = await import('../worktrees')

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-reopen-verify-repo-'))
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(dir, 'README.md'), '# repo\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--no-verify', '-m', 'init'])
  return dir
}

const failAttempt = (n: number) => ({
  attempt: n,
  at: 0,
  deterministic: {
    command: 'exit 1',
    exitCode: 1,
    passed: false,
    stdoutTail: '',
    stderrTail: '',
    durationMs: 1,
    timedOut: false,
  },
  critic: {
    ran: false,
    findings: [],
    reviewerRuntime: null,
    reviewerModel: null,
    reviewedSha: null,
  },
  status: 'fail' as const,
  structuredError: null,
})

/** A task under a run, with work to check. */
async function checkedTask(
  repoPath: string,
  opts: { verifyCmd: string; attemptsSoFar?: number },
): Promise<{ taskId: string; runId: string }> {
  const db = getDb()
  const task = createTask(db, {
    title: 'ship the parser',
    teamId: 'team1',
    sourceDelegationId: 'r1:deleg:agent:agent1:reflectTo:lead',
  })
  claimTask(db, task.id, 'agent1', 'openclaw')
  const run = createExecutionProcess(db, { taskId: task.id, executorType: 'openclaw' })
  const prov = await provisionTaskWorkspace(task.id, { repoPath, kind: 'code' })
  if (!prov.ok) throw new Error(`provision failed: ${prov.reason}`)
  const wt = prov.worktree.worktreePath
  await writeFile(path.join(wt, 'feature.txt'), 'work output\n', 'utf8')
  await writeFile(
    path.join(wt, 'init.sh'),
    `#!/usr/bin/env bash\nVERIFY_CMD='${opts.verifyCmd}'\n`,
    'utf8',
  )
  const soFar = opts.attemptsSoFar ?? 0
  if (soFar > 0)
    setTaskVerification(db, task.id, {
      status: 'fail',
      attempts: Array.from({ length: soFar }, (_, i) => failAttempt(i + 1)),
      debtNotes: [],
      updatedAt: 0,
    })
  return { taskId: task.id, runId: run.id }
}

/** A person marks it Done during the check, then reopens it. */
function doneThenReopened(taskId: string): void {
  const db = getDb()
  const done = updateStatus(db, taskId, 'done', { actor: 'person', humanOverride: true })
  if (!done.ok) throw new Error(`Done was refused: ${done.reason}`)
  const reopened = reopenTask(db, taskId)
  if (!reopened.ok) throw new Error(`Reopen was refused: ${reopened.reason}`)
}

const WORKTREE_TIMEOUT_MS = 90_000

describe('a check still running when a person reopens the task', () => {
  let repo: string
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-reopen-verify-home-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    repo = await initRepo()
    during.act = null
  })
  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
    await rm(repo, { recursive: true, force: true }).catch(() => {})
  })

  it(
    'a failure with attempts left does not move it back to In progress',
    async () => {
      const { taskId, runId } = await checkedTask(repo, { verifyCmd: 'exit 1' })
      during.act = doneThenReopened
      const r = await actOnTaskWorkspace(taskId, 'complete', { runId })
      expect(r.ok && r.action === 'complete' ? r.superseded : null).toBe(true)
      expect(getTask(getDb(), taskId)?.status).toBe('todo')
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'an exhausted check does not park it',
    async () => {
      const { taskId, runId } = await checkedTask(repo, { verifyCmd: 'exit 1', attemptsSoFar: 2 })
      during.act = doneThenReopened
      const r = await actOnTaskWorkspace(taskId, 'complete', { runId })
      expect(r.ok && r.action === 'complete' ? r.superseded : null).toBe(true)
      expect(getTask(getDb(), taskId)?.status).toBe('todo')
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a pass does not finish the newer run that already claimed it, and leaves it no verdict',
    async () => {
      const { taskId, runId } = await checkedTask(repo, { verifyCmd: 'exit 0' })
      during.act = (id) => {
        doneThenReopened(id)
        const db = getDb()
        claimTask(db, id, 'agent1', 'openclaw')
        createExecutionProcess(db, { taskId: id, executorType: 'openclaw' })
      }
      const r = await actOnTaskWorkspace(taskId, 'complete', { runId })
      expect(r.ok && r.action === 'complete' ? r.superseded : null).toBe(true)
      expect(getTask(getDb(), taskId)?.status).toBe('in_progress')
      expect(getTaskVerification(getDb(), taskId)).toBeNull()
    },
    WORKTREE_TIMEOUT_MS,
  )
})
