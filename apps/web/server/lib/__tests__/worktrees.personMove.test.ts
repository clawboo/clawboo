// A person deciding a task WHILE its verification check runs. The check is the
// real gate against a real git worktree (as in verification.test.ts); the only
// thing added is the person's board move, landed inside `verifyTask` exactly when
// a PATCH would land during a slow check. Their move is the outcome: the verdict
// is kept as a record of what the check found, but the task is not routed for
// review and nobody is told it was.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  claimTask,
  createTask,
  getComments,
  getTask,
  getTaskVerification,
  listUndeliveredInbox,
  setTaskVerification,
} from '@clawboo/db'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

/** The move a person makes while the check is running, if any. */
const during = vi.hoisted(() => ({ move: null as 'done' | 'cancelled' | null }))

vi.mock('../verification', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../verification')>()
  return {
    ...actual,
    verifyTask: async (input: Parameters<typeof actual.verifyTask>[0]) => {
      if (during.move) {
        const { updateStatus } = await import('@clawboo/db')
        // The board PATCH: a person's move, overriding a failing verdict on Done
        // the way the drawer's "ship it anyway" does.
        const moved = updateStatus(input.db, input.taskId, during.move, {
          actor: 'person',
          humanOverride: true,
        })
        if (!moved.ok) throw new Error(`the person's move was refused: ${moved.reason}`)
      }
      return actual.verifyTask(input)
    },
  }
})

const { getDb, resetDb } = await import('../db')
const { actOnTaskWorkspace, provisionTaskWorkspace } = await import('../worktrees')

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-person-verify-repo-'))
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(dir, 'README.md'), '# repo\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--no-verify', '-m', 'init'])
  return dir
}

/** A delegated task with a dirty worktree whose check always fails, and two
 *  failed attempts already on record, so this check exhausts the fix loop:
 *  left alone, the task is routed to blocked and the delegator is alerted. */
async function exhaustingTask(repoPath: string): Promise<string> {
  const db = getDb()
  const task = createTask(db, {
    title: 'ship the parser',
    teamId: 'team1',
    sourceDelegationId: 'r1:deleg:agent:agent1:reflectTo:lead',
  })
  claimTask(db, task.id, 'agent1', 'openclaw')
  const prov = await provisionTaskWorkspace(task.id, { repoPath, kind: 'code' })
  if (!prov.ok) throw new Error(`provision failed: ${prov.reason}`)
  const wt = prov.worktree.worktreePath
  await writeFile(path.join(wt, 'feature.txt'), 'work output\n', 'utf8')
  await writeFile(path.join(wt, 'init.sh'), "#!/usr/bin/env bash\nVERIFY_CMD='exit 1'\n", 'utf8')
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
  setTaskVerification(db, task.id, {
    status: 'fail',
    attempts: [failAttempt(1), failAttempt(2)],
    debtNotes: [],
    updatedAt: 0,
  })
  return task.id
}

const routedForReview = (taskId: string): boolean =>
  getComments(getDb(), taskId).some((c) => c.body.includes('routed to blocked for human review'))

// Real git, as in verification.test.ts, so the same widened timeout.
const WORKTREE_TIMEOUT_MS = 90_000

describe('verification while a person decides the task', () => {
  let repo: string
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-person-verify-home-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    repo = await initRepo()
    during.move = null
  })
  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory that
    // still holds an open file.
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
    await rm(repo, { recursive: true, force: true }).catch(() => {})
  })

  it(
    'left alone, an exhausted check parks the task and alerts the delegator',
    async () => {
      // The baseline the two cases below differ from.
      const taskId = await exhaustingTask(repo)
      const r = await actOnTaskWorkspace(taskId, 'complete')
      expect(r.ok && r.action === 'complete' ? r.taskStatus : null).toBe('blocked')
      expect(routedForReview(taskId)).toBe(true)
      expect(listUndeliveredInbox(getDb(), 'lead', { teamId: 'team1' })).toHaveLength(1)
    },
    WORKTREE_TIMEOUT_MS,
  )

  it.each(['cancelled', 'done'] as const)(
    'a person moving it to %s during the check keeps their move, with no review note and no alert',
    async (to) => {
      const taskId = await exhaustingTask(repo)
      during.move = to
      const r = await actOnTaskWorkspace(taskId, 'complete')

      expect(r.ok && r.action === 'complete' ? r.taskStatus : null).toBe(to)
      expect(r.ok && r.action === 'complete' ? r.verified : null).toBe('completed_with_debt')
      expect(getTask(getDb(), taskId)?.status).toBe(to)
      expect(routedForReview(taskId)).toBe(false)
      expect(listUndeliveredInbox(getDb(), 'lead', { teamId: 'team1' })).toEqual([])
      // What the check found is still on the task.
      expect(getTaskVerification(getDb(), taskId)?.status).toBe('completed_with_debt')
    },
    WORKTREE_TIMEOUT_MS,
  )
})
