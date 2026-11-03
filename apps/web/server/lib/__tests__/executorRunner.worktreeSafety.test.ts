// A task's second run must never delete the first run's uncommitted work. The
// runner rebuilds a checkout it believes was reaped, and the rebuild replaces
// the folder, so two things are pinned here against a real repository and a
// real board:
//   - a registration probe that fails once (git timing out, say) is not read as
//     "reaped": the run stops, retryable, and the checkout is untouched;
//   - a checkout that cannot be rebuilt without losing work stops the run with
//     a comment naming the folder, and nothing falls back to a fresh provision.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  createTask,
  getComments,
  getTask,
  getWorkspaceForTask,
  updateWorkspaceStatus,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'

/** How many registration probes, from now, answer as if `git worktree list` failed. */
const probe = vi.hoisted(() => ({ failures: 0 }))

vi.mock('@clawboo/worktrees', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@clawboo/worktrees')>()
  const failOnce = (): boolean => {
    if (probe.failures <= 0) return false
    probe.failures -= 1
    return true
  }
  return {
    ...actual,
    // Each probe answers a failed `git worktree list` the way the real one does:
    // the boolean form folds it into `false`, the three-way form says `unknown`.
    isWorktreeRegistered: async (repo: string, wt: string) =>
      failOnce() ? false : actual.isWorktreeRegistered(repo, wt),
    worktreeRegistration: async (repo: string, wt: string) =>
      failOnce() ? ('unknown' as const) : actual.worktreeRegistration(repo, wt),
  }
})

const { getDb, resetDb } = await import('../db')
const { runTaskOnRuntime } = await import('../executorRunner')

const execFileAsync = promisify(execFile)
async function git(cwd: string, args: string[]): Promise<string> {
  const { stdout } = await execFileAsync('git', args, { cwd, windowsHide: true })
  return stdout
}
async function initRepo(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), 'clawboo-wtsafe-repo-'))
  await git(dir, ['init', '-b', 'main'])
  await git(dir, ['config', 'user.name', 'test'])
  await git(dir, ['config', 'user.email', 'test@example.com'])
  await writeFile(path.join(dir, 'README.md'), '# repo\n')
  await git(dir, ['add', '-A'])
  await git(dir, ['commit', '--no-verify', '-m', 'init'])
  return dir
}

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
}

class CountingAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  startCount = 0
  constructor(readonly id: string) {}
  capabilities(): Capabilities {
    return CAPS
  }
  async health() {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startCount += 1
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const base = { runId: run.sessionKey, sessionId: run.sessionKey, ts: 1, seq: 1 }
    return (async function* () {
      yield {
        ...base,
        kind: 'done',
        reason: 'success',
        summary: 'Partway; more next run.',
      } as RuntimeEvent
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

describe('executor runner: a rebuild never discards uncommitted work', () => {
  let repo: string
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    probe.failures = 0
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-wtsafe-home-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    repo = await initRepo()
  })

  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
    await rm(repo, { recursive: true, force: true })
  })

  /** A first run that leaves its checkout (a pause), then work left uncommitted in it. */
  async function taskWithUncommittedWork(): Promise<{
    taskId: string
    wtPath: string
    branch: string
    tip: string
  }> {
    const taskId = createTask(getDb(), {
      title: 'Change some files',
      description: 'file-mutating work',
      status: 'todo',
      teamId: 'team-1',
    }).id
    const first = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => new CountingAdapter('claude-code'),
      taskId,
      assigneeAgentId: 'claude-1',
      repoPath: repo,
      keepForResume: true,
      disableMemoryAutoInject: true,
    })
    expect(first.ok).toBe(true)
    const ws = getWorkspaceForTask(getDb(), taskId)
    const wtPath = ws?.worktreePath ?? ''
    const branch = ws?.branch ?? ''
    expect(wtPath).not.toBe('')
    await writeFile(path.join(wtPath, 'notes.txt'), 'only here\n')
    await writeFile(path.join(wtPath, 'README.md'), '# repo\n\nedited, not committed\n')
    return { taskId, wtPath, branch, tip: (await git(repo, ['rev-parse', branch])).trim() }
  }

  async function expectUntouched(t: { wtPath: string; branch: string; tip: string }) {
    expect(await readFile(path.join(t.wtPath, 'notes.txt'), 'utf8')).toBe('only here\n')
    expect(await readFile(path.join(t.wtPath, 'README.md'), 'utf8')).toContain('edited')
    // No fresh provision either: that would have reset the branch and committed
    // a new scaffold on it.
    expect((await git(repo, ['rev-parse', t.branch])).trim()).toBe(t.tip)
  }

  it('R3: a registration probe that fails once stops the run as retryable and touches nothing', async () => {
    const t = await taskWithUncommittedWork()
    const second = new CountingAdapter('codex')
    probe.failures = 1

    const r = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => second,
      taskId: t.taskId,
      assigneeAgentId: 'codex-1',
      repoPath: repo,
      disableMemoryAutoInject: true,
    })

    expect(r).toEqual({ ok: false, reason: 'workspace_unavailable' })
    expect(second.startCount).toBe(0)
    await expectUntouched(t)
    expect(getTask(getDb(), t.taskId)?.status).toBe('todo')
    expect(getWorkspaceForTask(getDb(), t.taskId)?.worktreePath).toBe(t.wtPath)

    // The probe answers again: the next run reuses the very same checkout.
    const third = new CountingAdapter('codex')
    const again = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => third,
      taskId: t.taskId,
      assigneeAgentId: 'codex-1',
      repoPath: repo,
      keepForResume: true,
      disableMemoryAutoInject: true,
    })
    expect(again.ok).toBe(true)
    expect(third.startCount).toBe(1)
    expect(await readFile(path.join(t.wtPath, 'notes.txt'), 'utf8')).toBe('only here\n')
  })

  it('a stale row whose folder is still there is checked too, and a failed check stops the run', async () => {
    const t = await taskWithUncommittedWork()
    // The folder is clean again (its work committed), and the row says stale.
    await git(t.wtPath, ['add', '-A'])
    await git(t.wtPath, ['-c', 'user.name=t', '-c', 'user.email=t@e', 'commit', '-m', 'saved'])
    const tip = (await git(repo, ['rev-parse', t.branch])).trim()
    const ws = getWorkspaceForTask(getDb(), t.taskId)
    updateWorkspaceStatus(getDb(), ws?.id ?? '', 'stale')
    const second = new CountingAdapter('codex')
    probe.failures = 1

    const r = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => second,
      taskId: t.taskId,
      assigneeAgentId: 'codex-1',
      repoPath: repo,
      disableMemoryAutoInject: true,
    })

    expect(r).toEqual({ ok: false, reason: 'workspace_unavailable' })
    expect(second.startCount).toBe(0)
    expect(getTask(getDb(), t.taskId)?.status).toBe('todo')
    expect((await git(repo, ['rev-parse', t.branch])).trim()).toBe(tip)
    const note = getComments(getDb(), t.taskId).find((c) => c.body.includes(t.wtPath))
    expect(note?.body).toMatch(/^\[not started: worktree unchecked\]/)
  })

  it('a checkout git cannot read stops the run, names the folder, and waits for a person', async () => {
    const t = await taskWithUncommittedWork()
    // A lost admin folder: git no longer lists the checkout and cannot read it.
    const pointer = await readFile(path.join(t.wtPath, '.git'), 'utf8')
    await rm(pointer.replace(/^gitdir:\s*/, '').trim(), { recursive: true, force: true })
    const second = new CountingAdapter('codex')

    const r = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => second,
      taskId: t.taskId,
      assigneeAgentId: 'codex-1',
      repoPath: repo,
      disableMemoryAutoInject: true,
    })

    expect(r).toEqual({ ok: false, reason: 'workspace_unavailable' })
    expect(second.startCount).toBe(0)
    await expectUntouched(t)
    expect(getTask(getDb(), t.taskId)?.status).toBe('blocked')
    const note = getComments(getDb(), t.taskId).find((c) => c.body.includes(t.wtPath))
    expect(note?.body).toMatch(/^\[blocked: worktree kept\]/)
  })
})
