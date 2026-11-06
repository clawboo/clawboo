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
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  claimTask,
  createTask,
  getComments,
  getTask,
  getTaskVerification,
  setSetting,
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
import type { DebtNote } from '@clawboo/governance'
import type { DiffStat, Worktree } from '@clawboo/worktrees'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../db'
import { verifyTask } from '../verification'
import {
  readTeamVerifyCommand,
  teamVerifyCommandSettingKey,
} from '../verification/teamVerifyCommand'
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

/** A reviewer whose runtime reports usage with no price and no model. */
class UnpricedReviewerAdapter extends FakeReviewerAdapter {
  override events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const inner = super.events(run)
    return (async function* () {
      yield {
        runId: run.sessionKey,
        sessionId: run.sessionKey,
        ts: 1,
        seq: 0,
        kind: 'cost',
        costUsd: null,
        usage: { inputTokens: 40_000, outputTokens: 2_000 },
        model: null,
      } as RuntimeEvent
      yield* inner
    })()
  }
}

/** Fake reviewer that yields a scripted event list (kinds + fields), for the
 *  critic's outcome: a crash, a silence, a non-fatal hiccup. */
class ScriptedReviewerAdapter extends FakeReviewerAdapter {
  constructor(private readonly script: Array<Record<string, unknown>>) {
    super('')
  }
  override events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const script = this.script
    let seq = 0
    return (async function* () {
      for (const ev of script)
        yield {
          runId: run.sessionKey,
          sessionId: run.sessionKey,
          ts: 1,
          seq: (seq += 1),
          ...ev,
        } as RuntimeEvent
    })()
  }
}

async function provisionForTask(
  repoPath: string,
  verifyCmd: string,
  title = 'do the thing',
): Promise<{ taskId: string; worktree: Worktree }> {
  const db = getDb()
  const task = createTask(db, { title, teamId: 'team1' })
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

// REAL GIT, REAL WORKTREES, and that is the point of the file: the gate is
// exercised against an actual repository rather than a mock. It is also why the
// 30 s project default is not enough on the Windows runner, where every `git`
// invocation pays for process spawn and NTFS. The suite failed there on
// `skips the critic on a small, low-risk diff` at ~40 s while the same test
// passes comfortably on Linux and macOS.
//
// WIDENED, NOT SKIPPED. A genuine hang still fails, just later; what this stops
// is a slow runner being reported as a broken gate.
const WORKTREE_TIMEOUT_MS = 90_000

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
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
    await rm(repo, { recursive: true, force: true }).catch(() => {})
  })

  it(
    'a green deterministic gate promotes in_review → done',
    async () => {
      const { taskId } = await provisionForTask(repo, 'exit 0')
      const r = await actOnTaskWorkspace(taskId, 'complete')
      expect(r.ok && r.action === 'complete' ? r.verified : null).toBe('pass')
      expect(getTask(getDb(), taskId)?.status).toBe('done')
      expect(getTaskVerification(getDb(), taskId)?.status).toBe('pass')
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a failing gate blocks done and reverts to in_progress with a structured error',
    async () => {
      const { taskId } = await provisionForTask(repo, 'exit 1')
      const r = await actOnTaskWorkspace(taskId, 'complete')
      expect(r.ok && r.action === 'complete' ? r.verified : null).toBe('fail')
      const db = getDb()
      expect(getTask(db, taskId)?.status).toBe('in_progress')
      const comments = getComments(db, taskId)
      expect(
        comments.some(
          (c) => c.body.includes('Verification failed') && c.body.includes('How to fix'),
        ),
      ).toBe(true)
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'marks completed_with_debt at cycle exhaustion (never deadlocks)',
    async () => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 1')
      const db = getDb()
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
    },
    WORKTREE_TIMEOUT_MS,
  )

  const TOKEN_NOTE: DebtNote = {
    criterion: 'Token logged in plain text',
    severity: 'security',
    justification: 'unresolved at cycle exhaustion',
  }

  /** The item a red gate leaves, as `verifyTask` writes it. */
  const GATE_NOTE: DebtNote = {
    criterion: 'deterministic gate',
    severity: 'crash',
    justification: 'The deterministic gate failed: `exit 1` exited 1.',
  }

  /** The pass with debt a task still carries when it goes from blocked back to
   *  in_progress (a move to todo would clear it). */
  function seedPassWithDebt(taskId: string, debtNotes: DebtNote[] = [TOKEN_NOTE]): void {
    setTaskVerification(getDb(), taskId, {
      status: 'completed_with_debt',
      attempts: [
        {
          attempt: 1,
          at: 0,
          deterministic: {
            command: 'exit 0',
            exitCode: 0,
            passed: true,
            stdoutTail: '',
            stderrTail: '',
            durationMs: 1,
            timedOut: false,
          },
          critic: {
            ran: true,
            outcome: 'reviewed',
            findings: [
              {
                severity: 'security',
                title: TOKEN_NOTE.criterion,
                body: '',
                filePath: null,
                startLine: null,
                confidence: 0.9,
              },
            ],
            reviewerRuntime: 'fake-reviewer',
            reviewerModel: null,
            reviewedSha: null,
          },
          status: 'completed_with_debt',
          structuredError: null,
        },
      ],
      debtNotes,
      updatedAt: 0,
    })
  }

  it(
    'a pass with a completed review after a pass with debt carries no open items and keeps the history',
    async () => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
      seedPassWithDebt(taskId, [TOKEN_NOTE, GATE_NOTE])
      const db = getDb()
      const verdict = await verifyTask({
        db,
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
        riskFlag: true,
        makeReviewerAdapter: () => new FakeReviewerAdapter('{"findings":[]}'),
      })
      expect(verdict.status).toBe('pass')
      expect(verdict.attempts[1]?.critic).toMatchObject({ ran: true, outcome: 'reviewed' })
      expect(verdict.debtNotes).toEqual([])
      expect(getTaskVerification(db, taskId)?.debtNotes).toEqual([])
      expect(verdict.attempts.map((a) => a.status)).toEqual(['completed_with_debt', 'pass'])
      expect(verdict.attempts[0]?.critic.findings[0]?.title).toBe(TOKEN_NOTE.criterion)
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'starts no reviewer while a pause covers the task, and records that the review did not run',
    async () => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
      let started = 0
      const db = getDb()
      const verdict = await verifyTask({
        db,
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
        riskFlag: true,
        reviewPaused: () => true,
        makeReviewerAdapter: () => {
          const adapter = new FakeReviewerAdapter('{"findings":[]}')
          const start = adapter.start.bind(adapter)
          adapter.start = async (t, o) => {
            started += 1
            return start(t, o)
          }
          return adapter
        },
      })
      expect(started).toBe(0)
      expect(verdict.attempts.at(-1)?.critic).toMatchObject({ ran: true, outcome: 'errored' })
      expect(verdict.attempts.at(-1)?.critic.findings[0]?.body).toContain('paused')
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    "a pass with no review keeps the reviewer's open items and drops the gate's",
    async () => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
      seedPassWithDebt(taskId, [TOKEN_NOTE, GATE_NOTE])
      const db = getDb()
      // No reviewer, as on the workspace route: only the command ran, and it passed.
      const verdict = await verifyTask({
        db,
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
      })
      expect(verdict.status).toBe('pass')
      expect(verdict.attempts[1]?.critic.ran).toBe(false)
      expect(verdict.debtNotes).toEqual([TOKEN_NOTE])
      expect(getTaskVerification(db, taskId)?.debtNotes).toEqual([TOKEN_NOTE])
    },
    WORKTREE_TIMEOUT_MS,
  )

  it.each([
    [
      'errored',
      [
        { kind: 'error', code: 'authentication_failed', message: 'Invalid API key', fatal: true },
        { kind: 'done', reason: 'error', summary: 'Invalid API key' },
      ],
    ],
    ['empty', [{ kind: 'done', reason: 'success', summary: '' }]],
  ])(
    "a pass whose review came back %s keeps the reviewer's open items",
    async (outcome, script) => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
      seedPassWithDebt(taskId)
      const verdict = await verifyTask({
        db: getDb(),
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
        riskFlag: true,
        makeReviewerAdapter: () => new ScriptedReviewerAdapter(script),
      })
      expect(verdict.status).toBe('pass')
      expect(verdict.attempts[1]?.critic).toMatchObject({ ran: true, outcome })
      expect(verdict.debtNotes).toEqual([TOKEN_NOTE])
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a pass with debt after a pass with debt adds to the open items',
    async () => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 1')
      seedPassWithDebt(taskId)
      const db = getDb()
      const verdict = await verifyTask({
        db,
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
        maxFixCycles: 1,
      })
      expect(verdict.status).toBe('completed_with_debt')
      expect(verdict.debtNotes.map((d) => d.criterion)).toEqual([
        TOKEN_NOTE.criterion,
        'deterministic gate',
      ])
      expect(getTaskVerification(db, taskId)?.debtNotes).toHaveLength(2)
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a fail after a pass with debt keeps the open items it has not fixed',
    async () => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 1')
      seedPassWithDebt(taskId)
      const verdict = await verifyTask({
        db: getDb(),
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
        maxFixCycles: 5, // a raised budget, so this attempt fails instead of ending in debt
      })
      expect(verdict.status).toBe('fail')
      expect(verdict.debtNotes).toEqual([TOKEN_NOTE])
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    "an attempt with no command configured keeps every open item, the command's included",
    async () => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
      await writeFile(path.join(worktree.worktreePath, 'init.sh'), '#!/usr/bin/env bash\n', 'utf8')
      seedPassWithDebt(taskId, [TOKEN_NOTE, GATE_NOTE])
      const db = getDb()
      const verdict = await verifyTask({
        db,
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
        maxFixCycles: 5,
      })
      expect(verdict.attempts[1]?.deterministic).toMatchObject({
        command: '(none configured)',
        passed: false,
      })
      expect(verdict.status).toBe('fail')
      expect(verdict.debtNotes).toEqual([TOKEN_NOTE, GATE_NOTE])
      expect(getTaskVerification(db, taskId)?.debtNotes).toEqual([TOKEN_NOTE, GATE_NOTE])
    },
    WORKTREE_TIMEOUT_MS,
  )

  it.each([
    ['ends in debt', 1, 'completed_with_debt', [TOKEN_NOTE.criterion, 'SQL built from user input']],
    ['fails', 5, 'fail', [TOKEN_NOTE.criterion]],
  ])(
    "an attempt whose command passed but whose review %s drops the command's open item",
    async (_case, maxFixCycles, status, criteria) => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
      seedPassWithDebt(taskId, [TOKEN_NOTE, GATE_NOTE])
      const db = getDb()
      const blocking = JSON.stringify({
        findings: [{ severity: 'security', title: 'SQL built from user input', confidence: 0.9 }],
      })
      const verdict = await verifyTask({
        db,
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
        riskFlag: true,
        makeReviewerAdapter: () => new FakeReviewerAdapter(blocking),
        maxFixCycles,
      })
      expect(verdict.status).toBe(status)
      expect(verdict.attempts[1]?.deterministic.passed).toBe(true)
      expect(verdict.debtNotes.map((d) => d.criterion)).toEqual(criteria)
      expect(getTaskVerification(db, taskId)?.debtNotes.map((d) => d.criterion)).toEqual(criteria)
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a completed_with_debt verdict over a RED gate routes to BLOCKED (never silently done)',
    async () => {
      const { taskId } = await provisionForTask(repo, 'exit 1') // gate always red
      const db = getDb()
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
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'the read-only critic runs on a risky diff and a blocking finding fails the verdict',
    async () => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
      const db = getDb()
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
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'runs the critic on a small diff when the task names a risky action',
    async () => {
      const { taskId, worktree } = await provisionForTask(
        repo,
        'exit 0',
        'Deploy the signup service to production',
      )
      const verdict = await verifyTask({
        db: getDb(),
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
        makeReviewerAdapter: () => new FakeReviewerAdapter('{"findings":[]}'),
      })
      expect(verdict.attempts[0]?.critic.ran).toBe(true)
      expect(verdict.status).toBe('pass')
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    "prices a reviewer cost report with no model at the review's model (a local one is free)",
    async () => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
      const spends: Array<number | null> = []
      await verifyTask({
        db: getDb(),
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
        riskFlag: true,
        reviewerModel: 'ollama/llama3.2',
        makeReviewerAdapter: () => new UnpricedReviewerAdapter('{"findings":[]}'),
        onReviewerSpend: (s) => spends.push(s.usd),
      })
      expect(spends).toEqual([0])
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'skips the critic on a small, low-risk diff (passes on the gate alone)',
    async () => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
      const db = getDb()
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
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a reviewer that stops on a fatal error is recorded as errored, never as reviewed',
    async () => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
      const verdict = await verifyTask({
        db: getDb(),
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
        riskFlag: true,
        makeReviewerAdapter: () =>
          new ScriptedReviewerAdapter([
            {
              kind: 'error',
              code: 'authentication_failed',
              message: 'Invalid API key',
              fatal: true,
            },
            { kind: 'done', reason: 'error', summary: 'Invalid API key' },
          ]),
      })
      const critic = verdict.attempts[0]!.critic
      expect(critic).toMatchObject({ ran: true, outcome: 'errored' })
      expect(critic.findings[0]).toMatchObject({ severity: 'other', body: 'Invalid API key' })
      // Still non-blocking: the deterministic gate decides.
      expect(verdict.status).toBe('pass')
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'a non-fatal reviewer error does not end the review; silence is recorded as empty',
    async () => {
      const db = getDb()
      const reviewWith = async (script: Array<Record<string, unknown>>) => {
        const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
        const verdict = await verifyTask({
          db,
          taskId,
          repoPath: repo,
          worktree,
          diffStat: DIRTY_SMALL,
          reviewRootDir: path.join(home, 'reviews'),
          riskFlag: true,
          makeReviewerAdapter: () => new ScriptedReviewerAdapter(script),
        })
        return verdict.attempts[0]!.critic
      }
      const json = '{"findings":[{"severity":"style","title":"long line"}]}'
      const reviewed = await reviewWith([
        { kind: 'error', code: 'policy_denied', message: 'denied', fatal: false },
        { kind: 'text-delta', text: json, channel: 'assistant' },
        { kind: 'done', reason: 'success', summary: json },
      ])
      expect(reviewed).toMatchObject({ outcome: 'reviewed', findings: [{ title: 'long line' }] })

      const silent = await reviewWith([{ kind: 'done', reason: 'success', summary: '' }])
      expect(silent).toMatchObject({ ran: true, outcome: 'empty', findings: [] })
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'records an init.sh command the builder wrote as agent-sourced',
    async () => {
      // provisionForTask rewrites init.sh after the scaffold commit, as a builder would.
      const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
      const verdict = await verifyTask({
        db: getDb(),
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
      })
      expect(verdict.attempts[0]!.deterministic).toMatchObject({
        command: 'exit 0',
        commandSource: 'agent',
        passed: true,
      })
      const evidence = await readFile(path.join(worktree.worktreePath, 'VERIFICATION.md'), 'utf8')
      expect(evidence).toContain('- Command: `exit 0` (source: agent)')
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    'ignores a git replace ref the builder plants over the scaffold commit',
    async () => {
      const { taskId, worktree } = await provisionForTask(repo, 'exit 0')
      const wt = worktree.worktreePath
      // Commit the builder's init.sh and make it stand in for the scaffold commit.
      await git(wt, ['add', 'init.sh'])
      await git(wt, ['commit', '--no-verify', '-m', 'builder init.sh'])
      const { stdout } = await execFileAsync('git', ['rev-parse', 'HEAD'], { cwd: wt })
      await git(wt, ['replace', '-f', worktree.baseCommit, stdout.trim()])
      const verdict = await verifyTask({
        db: getDb(),
        taskId,
        repoPath: repo,
        worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
      })
      expect(verdict.attempts[0]!.deterministic).toMatchObject({
        command: 'exit 0',
        commandSource: 'agent',
      })
    },
    WORKTREE_TIMEOUT_MS,
  )

  it(
    "runs the team's verify command over the worktree's, and scaffolds it into init.sh",
    async () => {
      const db = getDb()
      setSetting(db, teamVerifyCommandSettingKey('team1'), JSON.stringify({ command: 'exit 1' }))

      // The builder rewrites init.sh to a check that always passes; the team's wins.
      const edited = await provisionForTask(repo, 'exit 0')
      const r = await actOnTaskWorkspace(edited.taskId, 'complete')
      expect(r.ok && r.action === 'complete' ? r.verified : null).toBe('fail')
      expect(getTaskVerification(db, edited.taskId)?.attempts[0]?.deterministic).toMatchObject({
        command: 'exit 1',
        commandSource: 'configured',
      })

      // A task whose init.sh still holds what clawboo scaffolded reads as `scaffold`
      // once the team's command is no longer passed in.
      const task = createTask(db, { title: 'untouched', teamId: 'team1' })
      claimTask(db, task.id, 'agent1', 'openclaw')
      const prov = await provisionTaskWorkspace(task.id, { repoPath: repo, kind: 'code' })
      if (!prov.ok) throw new Error(prov.reason)
      const initSh = await readFile(path.join(prov.worktree.worktreePath, 'init.sh'), 'utf8')
      expect(initSh).toContain("VERIFY_CMD='exit 1'")
      await writeFile(path.join(prov.worktree.worktreePath, 'feature.txt'), 'work\n', 'utf8')
      const verdict = await verifyTask({
        db,
        taskId: task.id,
        repoPath: repo,
        worktree: prov.worktree,
        diffStat: DIRTY_SMALL,
        reviewRootDir: path.join(home, 'reviews'),
      })
      expect(verdict.attempts[0]!.deterministic).toMatchObject({
        command: 'exit 1',
        commandSource: 'scaffold',
      })
      expect(readTeamVerifyCommand(db, 'team1')).toBe('exit 1')
      expect(readTeamVerifyCommand(db, 'other-team')).toBeNull()
    },
    WORKTREE_TIMEOUT_MS,
  )
})
