// Server worktree-orchestrator integration test. Exercises the full lifecycle
// against a REAL temp git repo + a REAL sqlite board, with `$HOME` overridden so
// the db and the worktree root land in a throwaway sandbox (never the dev's
// `~/.openclaw`). Proves: claim → provision records refs + scaffold (AC1);
// write handoff → cold resume reconstructs from the worktree (AC2); complete
// empty → done + cleanup / non-empty → verify gate runs + retain (AC3);
// read-only work is refused.

import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  claimTask,
  createDb,
  createTask,
  getTask,
  getWorkspaceForTask,
  listActiveWorkspaces,
  setTaskVerification,
  updateStatus,
  updateWorkspaceStatus,
} from '@clawboo/db'
import { isWorktreeRegistered, SOR_FILES } from '@clawboo/worktrees'

import { getDbPath } from '../db'
import {
  actOnTaskWorkspace,
  gcTaskWorkspaces,
  getTaskWorkspace,
  provisionTaskWorkspace,
  resumeTaskWorkspace,
  writeTaskHandoff,
} from '../worktrees'

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}

async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-srv-repo-'))
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(dir, 'README.md'), '# repo\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--no-verify', '-m', 'init'])
  return dir
}

describe('server worktree orchestrator (real git + real board)', () => {
  let repo: string
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-srv-home-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home // → getDbPath() + worktree root land in the sandbox
    repo = await initRepo()
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  })

  function newClaimedCodeTask(): string {
    const db = createDb(getDbPath())
    const task = createTask(db, {
      title: 'Implement feature X',
      description: 'Wire feature X end to end.',
      teamId: 'team-1',
      status: 'todo',
    })
    const claim = claimTask(db, task.id, 'agent-1', 'claude-code')
    expect(claim.ok).toBe(true)
    return task.id
  }

  it('AC1 — provisioning a claimed file-mutating task makes a worktree + branch + scaffold and records the board refs', async () => {
    const taskId = newClaimedCodeTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    expect(prov.ok).toBe(true)
    if (!prov.ok) return

    expect(prov.worktree.branch).toBe(`clawboo/task-${taskId}`)
    expect(existsSync(path.join(prov.worktree.worktreePath, SOR_FILES.task))).toBe(true)
    expect(existsSync(path.join(prov.worktree.worktreePath, SOR_FILES.init))).toBe(true)
    // Worktree lives OUTSIDE the user's repo (under the sandbox HOME).
    expect(prov.worktree.worktreePath.startsWith(home)).toBe(true)

    const db = createDb(getDbPath())
    const ws = getWorkspaceForTask(db, taskId)
    expect(ws?.worktreePath).toBe(prov.worktree.worktreePath)
    expect(ws?.branch).toBe(prov.worktree.branch)
    expect(ws?.status).toBe('active')
    const task = getTask(db, taskId)
    expect(task?.worktreeRef).toBe(prov.worktree.worktreePath)
    expect(task?.branchRef).toBe(prov.worktree.branch)
  })

  it('AC2 — a handoff round-trips and the cold-resume read reconstructs state from the worktree', async () => {
    const taskId = newClaimedCodeTask()
    await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })

    const wrote = await writeTaskHandoff(taskId, {
      handoffFrom: 'Builder Boo',
      runtime: 'claude-code',
      completedSubtasks: ['parsed input', 'added feature.ts'],
      brokenOrUnverified: ['large-file path untested'],
      nextBestStep: 'wire feature.ts into the index',
      commands: { init: './init.sh', verify: 'pnpm test', start: '' },
      evidence: { testResults: '3 passed' },
      warnings: [],
    })
    expect(wrote.ok).toBe(true)

    const view = await getTaskWorkspace(taskId)
    expect(view.ok).toBe(true)
    if (!view.ok) return
    expect(view.resume?.hasHandoff).toBe(true)
    expect(view.resume?.lastRuntime).toBe('claude-code')
    expect(view.resume?.done).toContain('added feature.ts')
    expect(view.resume?.next).toBe('wire feature.ts into the index')
    expect(view.handoff?.runtime).toBe('claude-code')
  })

  it('AC3 — complete with an empty diff cleans up the worktree and marks the task done', async () => {
    const taskId = newClaimedCodeTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    expect(prov.ok).toBe(true)
    if (!prov.ok) return

    // A realistic clock-out writes a handoff first — which must NOT count as
    // deliverable work (it's SoR bookkeeping), so the empty diff still cleans up.
    await writeTaskHandoff(taskId, {
      handoffFrom: 'A',
      runtime: 'codex',
      completedSubtasks: [],
      brokenOrUnverified: [],
      nextBestStep: '',
      commands: { init: './init.sh', verify: '', start: '' },
      evidence: {},
      warnings: [],
    })

    const result = await actOnTaskWorkspace(taskId, 'complete')
    expect(result.ok).toBe(true)
    if (!result.ok || result.action !== 'complete') return
    expect(result.complete.cleaned).toBe(true)
    expect(result.taskStatus).toBe('done')
    expect(existsSync(prov.worktree.worktreePath)).toBe(false)

    const db = createDb(getDbPath())
    expect(getTask(db, taskId)?.status).toBe('done')
    expect(getWorkspaceForTask(db, taskId)?.status).toBe('archived')
  })

  it('AC3 — an empty diff lands done even over a stale non-promotable verdict (override)', async () => {
    const taskId = newClaimedCodeTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    expect(prov.ok).toBe(true)
    if (!prov.ok) return

    // An earlier dirty attempt failed verification; the fix reduced the diff to
    // empty on this re-complete. The empty-diff terminal must not be blocked by the
    // stale failing verdict (an empty diff has no deliverable to verify).
    const db = createDb(getDbPath())
    setTaskVerification(db, taskId, {
      status: 'fail',
      attempts: [
        {
          attempt: 1,
          at: Date.now(),
          deterministic: {
            command: 'pnpm test',
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
          status: 'fail',
          structuredError: null,
        },
      ],
      debtNotes: [],
      updatedAt: Date.now(),
    })

    const result = await actOnTaskWorkspace(taskId, 'complete')
    expect(result.ok).toBe(true)
    if (!result.ok || result.action !== 'complete') return
    expect(result.taskStatus).toBe('done')
    expect(getTask(db, taskId)?.status).toBe('done')
  })

  it('AC3 — complete with a non-empty diff retains the worktree + branch; the verify gate runs', async () => {
    const taskId = newClaimedCodeTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    expect(prov.ok).toBe(true)
    if (!prov.ok) return
    await writeFile(path.join(prov.worktree.worktreePath, 'feature.ts'), 'export const x = 1\n')

    const result = await actOnTaskWorkspace(taskId, 'complete')
    if (!result.ok || result.action !== 'complete') throw new Error('expected complete')
    expect(result.complete.dirty).toBe(true)
    expect(result.complete.cleaned).toBe(false)
    // Verify runs on the dirty diff. With the scaffold's placeholder VERIFY_CMD
    // (and no reviewer adapter) the deterministic gate FAILs → the task lands
    // back in `in_progress` for a fix; the worktree + branch are retained.
    expect(result.taskStatus).toBe('in_progress')
    expect(existsSync(prov.worktree.worktreePath)).toBe(true)

    const db = createDb(getDbPath())
    expect(getTask(db, taskId)?.status).toBe('in_progress')
    expect(getWorkspaceForTask(db, taskId)?.status).toBe('active')
  })

  it('refuses to provision a worktree for read-only research work', async () => {
    const db = createDb(getDbPath())
    const task = createTask(db, { title: 'Research the options', status: 'todo' })
    const prov = await provisionTaskWorkspace(task.id, { repoPath: repo, kind: 'research' })
    expect(prov.ok).toBe(false)
    if (!prov.ok) expect(prov.reason).toBe('no_isolation')
  })

  it('resumeTaskWorkspace rebuilds a GC-reaped worktree from its retained branch', async () => {
    const taskId = newClaimedCodeTask()
    const prov = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    expect(prov.ok).toBe(true)
    if (!prov.ok) return
    const wtPath = prov.worktree.worktreePath
    const db = createDb(getDbPath())
    const wsId = getWorkspaceForTask(db, taskId)!.id

    // Simulate a GC reap: the worktree dir is gone (branch kept) + row marked stale.
    await rm(wtPath, { recursive: true, force: true })
    updateWorkspaceStatus(db, wsId, 'stale')
    expect(existsSync(wtPath)).toBe(false)

    const resumed = await resumeTaskWorkspace(taskId, { repoPath: repo })
    expect(resumed.ok).toBe(true)
    if (!resumed.ok) return
    // The checkout is rebuilt (a real, populated worktree — not a missing cwd).
    expect(existsSync(resumed.worktree.worktreePath)).toBe(true)
    expect(await isWorktreeRegistered(repo, resumed.worktree.worktreePath)).toBe(true)
    expect(existsSync(path.join(resumed.worktree.worktreePath, SOR_FILES.task))).toBe(true)
    // The row is flipped back to active.
    expect(getWorkspaceForTask(db, taskId)?.status).toBe('active')
  })

  it('provisionTaskWorkspace dedups — a repeat provision reuses the one active row', async () => {
    const taskId = newClaimedCodeTask()
    const a = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    const b = await provisionTaskWorkspace(taskId, { repoPath: repo, kind: 'code' })
    expect(a.ok && b.ok).toBe(true)
    if (!a.ok || !b.ok) return
    expect(b.workspaceId).toBe(a.workspaceId) // same row, not a duplicate
    const db = createDb(getDbPath())
    const activeForTask = listActiveWorkspaces(db).filter((w) => w.taskId === taskId)
    expect(activeForTask).toHaveLength(1)
  })

  it('GC reads task status LIVE: in_progress + in_review worktrees are skipped, an inactive one is reaped', async () => {
    // The reap callback reads each task's CURRENT status (getTask), not a frozen
    // snapshot, so a task that is active at reap time is genuinely protected. This
    // exercises the real gcTaskWorkspaces → gcWorktrees → live callback path and
    // locks the predicate to BOTH active statuses (in_progress AND in_review).
    const db = createDb(getDbPath())
    const running = newClaimedCodeTask() // stays in_progress
    const reviewing = newClaimedCodeTask() // → in_review
    const released = newClaimedCodeTask() // → todo (no longer active)
    const pRun = await provisionTaskWorkspace(running, { repoPath: repo, kind: 'code' })
    const pRev = await provisionTaskWorkspace(reviewing, { repoPath: repo, kind: 'code' })
    const pRel = await provisionTaskWorkspace(released, { repoPath: repo, kind: 'code' })
    expect(pRun.ok && pRev.ok && pRel.ok).toBe(true)
    if (!pRun.ok || !pRev.ok || !pRel.ok) return

    expect(updateStatus(db, reviewing, 'in_review').ok).toBe(true)
    expect(updateStatus(db, released, 'todo').ok).toBe(true)

    // maxAgeMs:0 ages every worktree, so the LIVE status read is the sole gate.
    const summary = await gcTaskWorkspaces({ maxAgeMs: 0, maxCount: 1000 })

    expect(summary.skipped.map((s) => s.taskId).sort()).toEqual([reviewing, running].sort())
    expect(existsSync(pRun.worktree.worktreePath)).toBe(true)
    expect(existsSync(pRev.worktree.worktreePath)).toBe(true)
    expect(summary.reaped).toContain(released)
    expect(existsSync(pRel.worktree.worktreePath)).toBe(false)
  })
})
