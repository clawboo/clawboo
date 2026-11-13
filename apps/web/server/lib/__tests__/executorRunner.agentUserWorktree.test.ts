// A board task's worktree with agents on their own OS user, through the task
// runner: a checkout that cannot be rebuilt stops the run as retryable (never a
// fresh provision, which would reset the branch), and the recorded checkout is
// looked up against the repository its row names.

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { createTask, getComments, getTask, getWorkspaceForTask } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { setWorktreeIo } from '@clawboo/worktrees'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { mirrorPathFor } from '../agentUser/mirror'
import { setActiveAgentHost } from '../agentUser/state'
import { installAgentWorktreeIo } from '../agentUser/worktreeIo'
import { startInProcessHost, type InProcessHost } from '../agentUser/__tests__/inProcessHost'
import { getDb, resetDb } from '../db'
import { runTaskOnRuntime } from '../executorRunner'
import { actOnTaskWorkspace } from '../worktrees'
import { seedSandboxTeam } from './seedTeam'

const posix = process.platform !== 'win32'

const gitEnv = {
  GIT_AUTHOR_NAME: 't',
  GIT_AUTHOR_EMAIL: 't@example.com',
  GIT_COMMITTER_NAME: 't',
  GIT_COMMITTER_EMAIL: 't@example.com',
}
const git = (cwd: string, ...args: string[]): string =>
  execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...gitEnv } }).trim()

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
      yield { ...base, kind: 'done', reason: 'success', summary: 'Partway.' } as RuntimeEvent
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

describe.runIf(posix)('task runs in worktrees under agent isolation', { timeout: 120_000 }, () => {
  let home: string
  let repo: string
  let h: InProcessHost
  /** When set and true for a git call's argv, the host fails to start it. */
  let failWhen: ((argv: string[]) => boolean) | null

  beforeEach(async () => {
    home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'exec-agent-wt-')))
    fs.mkdirSync(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    vi.stubEnv('HOME', home)
    vi.stubEnv('CLAWBOO_HOME', path.join(home, '.clawboo'))
    vi.stubEnv('CLAWBOO_WORK_DIR', path.join(home, 'work'))
    for (const [k, v] of Object.entries(gitEnv)) vi.stubEnv(k, v)
    fs.mkdirSync(path.join(home, 'work'))
    seedSandboxTeam(home)
    repo = path.join(home, 'repo')
    fs.mkdirSync(repo)
    git(repo, 'init', '-q', '-b', 'main')
    fs.writeFileSync(path.join(repo, 'README.md'), '# repo\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'init')

    vi.stubEnv('CLAWBOO_AGENT_USER', 'clawboo-agent')
    h = startInProcessHost()
    const hello = await h.client.waitForHello()
    setActiveAgentHost({
      client: h.client,
      hello: { ...hello, home: path.join(home, 'agent-home') },
      config: { user: 'clawboo-agent', switch: 'sudo', socket: null },
    })
    installAgentWorktreeIo()
    failWhen = null
    const spawn = h.client.spawn.bind(h.client)
    vi.spyOn(h.client, 'spawn').mockImplementation((o) => {
      if (failWhen?.([o.command, ...o.args])) throw new Error('the agent host did not answer')
      return spawn(o)
    })
  })

  afterEach(() => {
    resetDb()
    setWorktreeIo(null)
    setActiveAgentHost(null)
    h.client.close()
    vi.restoreAllMocks()
    vi.unstubAllEnvs()
    fs.rmSync(home, { recursive: true, force: true })
  })

  async function firstRun(): Promise<{ taskId: string; wtPath: string; branch: string }> {
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
    return { taskId, wtPath: ws?.worktreePath ?? '', branch: ws?.branch ?? '' }
  }

  it('a checkout that cannot be rebuilt stops the run as retryable, with no fresh provision', async () => {
    const t = await firstRun()
    fs.writeFileSync(path.join(t.wtPath, 'feature.txt'), 'kept on the branch\n')
    await actOnTaskWorkspace(t.taskId, 'pause')
    const tip = git(mirrorPathFor(repo), 'rev-parse', t.branch)

    failWhen = (argv) => argv.includes('worktree') && argv.includes('add')
    const second = new CountingAdapter('codex')
    const r = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => second,
      taskId: t.taskId,
      assigneeAgentId: 'codex-1',
      repoPath: repo,
      keepForResume: true,
      disableMemoryAutoInject: true,
    })

    expect(r).toEqual({ ok: false, reason: 'workspace_unavailable' })
    expect(second.startCount).toBe(0)
    // To do, not Needs you: nothing is wrong with the work, it can run again.
    expect(getTask(getDb(), t.taskId)?.status).toBe('todo')
    expect(git(mirrorPathFor(repo), 'rev-parse', t.branch)).toBe(tip)
    const note = getComments(getDb(), t.taskId).find((c) => c.body.includes('Could not rebuild'))
    expect(note?.body).toMatch(/^\[not started: worktree not rebuilt\]/)
  })

  it('finds the recorded checkout through the repository its row names', async () => {
    const t = await firstRun()
    fs.writeFileSync(path.join(t.wtPath, 'notes.txt'), 'only here\n')
    // The next run names the same repository by another path.
    const link = path.join(home, 'repo-link')
    fs.symlinkSync(repo, link)

    const second = new CountingAdapter('codex')
    const r = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => second,
      taskId: t.taskId,
      assigneeAgentId: 'codex-1',
      repoPath: link,
      keepForResume: true,
      disableMemoryAutoInject: true,
    })

    expect(r.ok).toBe(true)
    expect(second.startCount).toBe(1)
    expect(fs.readFileSync(path.join(t.wtPath, 'notes.txt'), 'utf8')).toBe('only here\n')
  })
})
