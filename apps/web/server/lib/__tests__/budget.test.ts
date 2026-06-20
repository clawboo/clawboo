// Budget kill-switch integration test. Drives the runner against a REAL board + a
// REAL temp git worktree with `$HOME` sandboxed. A FAKE adapter emits a `cost`
// event larger than a seeded team budget → the runner must atomically pause the
// budget, abort the live run mid-stream, release the task, and audit it. The

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import {
  createDb,
  createTask,
  getBudget,
  listGovernanceAudit,
  resumeBudget,
  setBudgetLimit,
  getTask,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../db'
import { runTaskOnRuntime } from '../executorRunner'

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<void> {
  await execFileAsync('git', args, { cwd, windowsHide: true })
}
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-budget-repo-'))
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

/** Fake adapter that emits one big `cost` event, then done — and records abort. */
class FakeCostAdapter implements RuntimeAdapter {
  readonly id = 'fake-cost'
  readonly participantKind = 'agent' as const
  aborted = false
  constructor(private readonly costUsd: number) {}
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
    const costUsd = this.costUsd
    let seq = 0
    const base = () => ({
      runId: run.sessionKey,
      sessionId: run.sessionKey,
      ts: 1,
      seq: (seq += 1),
    })
    return (async function* () {
      yield {
        ...base(),
        kind: 'cost',
        costUsd,
        usage: { inputTokens: 100, outputTokens: 100 },
        model: 'm',
        estimated: false,
      } as RuntimeEvent
      yield { ...base(), kind: 'done', reason: 'success', summary: 'done' } as RuntimeEvent
    })()
  }
  async abort() {
    this.aborted = true
  }
  async setModel() {}
  async writeContext() {}
}

describe('budget kill-switch (real board + real git worktree)', () => {
  let repo: string
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-budget-home-'))
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

  function newTask(): string {
    return createTask(createDb(getDbPath()), { title: 'spend', status: 'todo', teamId: 'team-1' })
      .id
  }

  it('auto-pauses + aborts the run when a cost event crosses the team budget', async () => {
    const db = createDb(getDbPath())
    setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 10, mode: 'cap' }) // $0.10 hard cap
    const taskId = newTask()
    const fake = new FakeCostAdapter(0.5) // 50¢ ≫ 10¢

    const result = await runTaskOnRuntime({
      db,
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'a1',
      repoPath: repo,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doneReason).toBe('aborted')
    expect(result.status).toBe('todo') // released, retryable after a human raises the cap
    expect(fake.aborted).toBe(true) // the live run was killed mid-stream
    expect(getTask(db, taskId)?.status).toBe('todo')
    expect(getBudget(db, 'team', 'team-1')?.status).toBe('paused')
    expect(listGovernanceAudit(db, { eventType: 'budget' }).length).toBeGreaterThan(0)
  })

  it('a warn-mode budget does NOT pause — it tracks + warns, the run completes', async () => {
    const db = createDb(getDbPath())
    // Track-and-warn: a warn budget far below the spend. The run must finish.
    setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 10, mode: 'warn' })
    const taskId = newTask()
    const fake = new FakeCostAdapter(0.5) // 50¢ ≫ 10¢ warn threshold

    const result = await runTaskOnRuntime({
      db,
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'a1',
      repoPath: repo,
    })

    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doneReason).toBe('success') // NOT aborted
    expect(fake.aborted).toBe(false) // the run was never killed
    expect(getBudget(db, 'team', 'team-1')?.status).not.toBe('paused') // never pauses
    // A warning was emitted to the governance audit log (reason: 'warn').
    const budgetAudits = listGovernanceAudit(db, { eventType: 'budget' })
    expect(budgetAudits.some((a) => a.summary.includes('"reason":"warn"'))).toBe(true)
  })

  it('a human resume (raise the cap) lets a re-run proceed', async () => {
    const db = createDb(getDbPath())
    setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 10, mode: 'cap' })
    const taskId = newTask()
    await runTaskOnRuntime({
      db,
      makeAdapter: () => new FakeCostAdapter(0.5),
      taskId,
      assigneeAgentId: 'a1',
      repoPath: repo,
    })
    expect(getBudget(db, 'team', 'team-1')?.status).toBe('paused')

    // Override: resume the scope AND raise the cap so the re-run has headroom.
    resumeBudget(db, 'team', 'team-1')
    setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 1_000_000 })

    const reFake = new FakeCostAdapter(0.1)
    const r2 = await runTaskOnRuntime({
      db,
      makeAdapter: () => reFake,
      taskId,
      assigneeAgentId: 'a1',
      repoPath: repo,
    })
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.doneReason).toBe('success')
    expect(reFake.aborted).toBe(false)
  })
})
