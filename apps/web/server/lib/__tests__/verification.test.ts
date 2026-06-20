// Verification gate integration test. Drives the real gate (deterministic
// build/test/lint + an optional read-only critic) against a REAL sqlite board + a
// REAL temp git repo + worktree, with `$HOME` sandboxed so nothing touches the
// dev's `~/.openclaw`. The verify command is `exit 0` / `exit 1` (no toolchain
// needed), and the critic uses a FAKE reviewer adapter that yields a scripted
// typed verdict — so we assert the COMPOSITION (gate → critic → typed verdict →
// board rule + structured-error route-back + debt-on-exhaustion), not adapter
// internals.

import { execFile } from 'node:child_process'
import { existsSync, readdirSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  claimTask,
  createDb,
  createTask,
  getComments,
  getTask,
  getTaskVerification,
  setTaskVerification,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import type { DiffStat, Worktree } from '@clawboo/worktrees'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../db'
import { verifyTask } from '../verification'
import { actOnTaskWorkspace, provisionTaskWorkspace } from '../worktrees'

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-verify-repo-'))
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(dir, 'README.md'), '# repo\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--no-verify', '-m', 'init'])
  return dir
}

const FULL_CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
}
const DIRTY_SMALL: DiffStat = { filesChanged: 1, insertions: 1, deletions: 0, dirty: true }

/** Fake reviewer: yields a single scripted JSON verdict, then done. */
class FakeReviewerAdapter implements RuntimeAdapter {
  readonly id = 'fake-reviewer'
  readonly participantKind = 'agent' as const
  constructor(private readonly verdictJson: string) {}
  capabilities(): Capabilities {
    return FULL_CAPS
  }
  async health() {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const json = this.verdictJson
    let seq = 0
    const base = () => ({
      runId: run.sessionKey,
      sessionId: run.sessionKey,
      ts: 1,
      seq: (seq += 1),
    })
    return (async function* () {
      yield { ...base(), kind: 'text-delta', text: json, channel: 'assistant' } as RuntimeEvent
      yield { ...base(), kind: 'done', reason: 'success', summary: json } as RuntimeEvent
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

async function provisionForTask(
  repoPath: string,
  verifyCmd: string,
): Promise<{ taskId: string; worktree: Worktree }> {
  const db = createDb(getDbPath())
  const task = createTask(db, { title: 'do the thing', teamId: 'team1' })
  claimTask(db, task.id, 'agent1', 'openclaw') // → in_progress (a real run owns it before completion)
  const prov = await provisionTaskWorkspace(task.id, { repoPath, kind: 'code' })
  if (!prov.ok) throw new Error(`provision failed: ${prov.reason}`)
  const wt = prov.worktree.worktreePath
  await writeFile(path.join(wt, 'feature.txt'), 'work output\n', 'utf8') // non-SOR ⇒ dirty diff
  await writeFile(
    path.join(wt, 'init.sh'),
    `#!/usr/bin/env bash\nVERIFY_CMD='${verifyCmd}'\n`,
    'utf8',
  )
  return { taskId: task.id, worktree: prov.worktree }
}

describe('verification gate (real board + real git worktree)', () => {
  let repo: string
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-verify-home-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    repo = await initRepo()
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
    await rm(repo, { recursive: true, force: true }).catch(() => {})
  })

  it('a green deterministic gate promotes in_review → done', async () => {
    const { taskId } = await provisionForTask(repo, 'exit 0')
    const r = await actOnTaskWorkspace(taskId, 'complete')
    expect(r.ok && r.action === 'complete' ? r.verified : null).toBe('pass')
    expect(getTask(createDb(getDbPath()), taskId)?.status).toBe('done')
    expect(getTaskVerification(createDb(getDbPath()), taskId)?.status).toBe('pass')
  })

  it('a failing gate blocks done and reverts to in_progress with a structured error', async () => {
    const { taskId } = await provisionForTask(repo, 'exit 1')
    const r = await actOnTaskWorkspace(taskId, 'complete')
    expect(r.ok && r.action === 'complete' ? r.verified : null).toBe('fail')
    const db = createDb(getDbPath())
    expect(getTask(db, taskId)?.status).toBe('in_progress')
    const comments = getComments(db, taskId)
    expect(
      comments.some((c) => c.body.includes('Verification failed') && c.body.includes('How to fix')),
    ).toBe(true)
  })

  it('marks completed_with_debt at cycle exhaustion (never deadlocks)', async () => {
    const { taskId, worktree } = await provisionForTask(repo, 'exit 1')
    const db = createDb(getDbPath())
    const verdict = await verifyTask({
      db,
      taskId,
      repoPath: repo,
      worktree,
      diffStat: DIRTY_SMALL,
      reviewRootDir: path.join(home, 'reviews'),
      maxFixCycles: 1, // exhaust immediately
    })
    expect(verdict.status).toBe('completed_with_debt')
    expect(verdict.debtNotes.length).toBeGreaterThan(0)
  })

  it('a completed_with_debt verdict over a RED gate routes to BLOCKED (never silently done)', async () => {
    const { taskId } = await provisionForTask(repo, 'exit 1') // gate always red
    const db = createDb(getDbPath())
    // Pre-seed 2 prior failing attempts so the next cycle (default max 3) exhausts
    // the fix loop → completed_with_debt with a still-failing deterministic gate.
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
    setTaskVerification(db, taskId, {
      status: 'fail',
      attempts: [failAttempt(1), failAttempt(2)],
      debtNotes: [],
      updatedAt: 0,
    })

    const r = await actOnTaskWorkspace(taskId, 'complete')
    expect(r.ok && r.action === 'complete' ? r.verified : null).toBe('completed_with_debt')
    // A red build/test gate is NOT auto-promotable — routed to a human, not done.
    expect(getTask(db, taskId)?.status).toBe('blocked')
    expect(
      getComments(db, taskId).some((c) =>
        c.body.toLowerCase().includes('blocked for human review'),
      ),
    ).toBe(true)
  })

  it('the read-only critic runs on a risky diff and a blocking finding fails the verdict', async () => {
    const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
    const db = createDb(getDbPath())
    const reviewRoot = path.join(home, 'reviews')
    const blocking = JSON.stringify({
      findings: [{ severity: 'security', title: 'hardcoded token', confidence: 0.9 }],
    })
    const verdict = await verifyTask({
      db,
      taskId,
      repoPath: repo,
      worktree,
      diffStat: DIRTY_SMALL,
      reviewRootDir: reviewRoot,
      riskFlag: true, // force the critic regardless of diff size
      reviewerModel: 'reviewer-model-x',
      makeReviewerAdapter: () => new FakeReviewerAdapter(blocking),
    })
    expect(verdict.status).toBe('fail')
    expect(verdict.attempts[0]?.critic.ran).toBe(true)
    expect(verdict.attempts[0]?.critic.reviewedSha).toBeTruthy()
    // The reviewer model is recorded on the verdict so a same-model review's bias
    // caveat is visible (builder ≠ judge is context-level + optionally model-level).
    expect(verdict.attempts[0]?.critic.reviewerModel).toBe('reviewer-model-x')
    // the detached review worktree was torn down (read-only, push-less, ephemeral)
    expect(!existsSync(reviewRoot) || readdirSync(reviewRoot).length === 0).toBe(true)
  })

  it('skips the critic on a small, low-risk diff (passes on the gate alone)', async () => {
    const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
    const db = createDb(getDbPath())
    const verdict = await verifyTask({
      db,
      taskId,
      repoPath: repo,
      worktree,
      diffStat: DIRTY_SMALL,
      reviewRootDir: path.join(home, 'reviews'),
      makeReviewerAdapter: () => new FakeReviewerAdapter('{"findings":[]}'),
    })
    expect(verdict.status).toBe('pass')
    expect(verdict.attempts[0]?.critic.ran).toBe(false)
  })
})
