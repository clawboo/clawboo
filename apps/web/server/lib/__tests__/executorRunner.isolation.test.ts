/**
 * Isolation + claim-safety guards on the per-task runner.
 *
 * Two invariants, both about what happens when something goes wrong AFTER the
 * atomic claim:
 *
 *  1. A file-mutating task with no provisionable worktree is REFUSED. Running it
 *     with a null cwd would execute the agent in the server's own working
 *     directory — and the drivers run with their permission gates bypassed on the
 *     strength of worktree isolation, so that combination must never happen.
 *  2. An unexpected throw releases the claim. Otherwise the task sits
 *     `in_progress` with no runner behind it until the stale sweep.
 */

import { mkdir, mkdtemp, rm, stat, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createTask, getTask } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'

import { getDb, resetDb } from '../db'
import { runTaskOnRuntime } from '../executorRunner'
import type { RuntimeRunContext } from '../runtimes/types'

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
  contextWindowTokens: 200_000,
}

/** Records whether it was ever started, and can be scripted to throw. */
class ProbeAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  startCount = 0

  constructor(
    readonly id: string,
    private readonly throwOnStart = false,
  ) {}

  capabilities(): Capabilities {
    return CAPS
  }
  async health() {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startCount += 1
    if (this.throwOnStart) throw new Error('driver exploded mid-start')
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: 'rid-0' }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const base = { runId: run.runId ?? run.sessionKey, sessionId: run.sessionKey, ts: 1, seq: 1 }
    return (async function* () {
      yield { ...base, kind: 'done', reason: 'success', summary: 'ok' } as RuntimeEvent
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

describe('executor runner — isolation + claim safety', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-iso-home-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  function newTask(): string {
    return createTask(getDb(), {
      title: 'Change some files',
      description: 'file-mutating work',
      status: 'todo',
      teamId: 'team-1',
    }).id
  }

  it('refuses a file-mutating task that has no worktree instead of running in the server cwd', async () => {
    const taskId = newTask()
    const fake = new ProbeAdapter('claude-code')

    const result = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'claude-1',
      disableMemoryAutoInject: true,
      // kind defaults to 'code' (file-mutating) and no repoPath is supplied,
      // so isolation is required but cannot be provisioned.
    })

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('workspace_unavailable')
    // The agent must never have been started.
    expect(fake.startCount).toBe(0)
    // And the task goes back to the queue rather than being stranded.
    expect(getTask(getDb(), taskId)?.status).toBe('todo')
  })

  it('still runs read-only work without a worktree', async () => {
    const taskId = newTask()
    const fake = new ProbeAdapter('claude-code')

    const result = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'claude-1',
      disableMemoryAutoInject: true,
      kind: 'research', // mutates no files — legitimately needs no isolation
    })

    expect(result.ok).toBe(true)
    expect(fake.startCount).toBe(1)
  })

  /** Run read-only work and return the cwd the driver was handed. */
  async function readOnlyRunCwd(
    runtime: string,
    teamId: string | null,
  ): Promise<{ ok: boolean; cwd: string | null | undefined; fake: ProbeAdapter }> {
    const taskId = createTask(getDb(), {
      title: 'Research something',
      status: 'todo',
      ...(teamId ? { teamId } : {}),
    }).id
    const fake = new ProbeAdapter(runtime)
    let cwd: string | null | undefined
    const result = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: (ctx: RuntimeRunContext) => {
        if (ctx.memoryScope) cwd = ctx.cwd
        return fake
      },
      taskId,
      assigneeAgentId: 'agent-1',
      disableMemoryAutoInject: true,
      kind: 'research',
    })
    return { ok: result.ok, cwd, fake }
  }

  for (const runtime of ['claude-code', 'codex', 'hermes']) {
    it(`starts read-only ${runtime} work in its team's folder, not the server cwd`, async () => {
      const { ok, cwd } = await readOnlyRunCwd(runtime, 'team-1')

      expect(ok).toBe(true)
      const folder = path.join(home, '.clawboo', 'workspaces', 'team-1')
      expect(cwd).toBe(folder)
      expect((await stat(folder)).isDirectory()).toBe(true)
      if (process.platform !== 'win32') expect((await stat(folder)).mode & 0o777).toBe(0o700)
    })
  }

  it('starts read-only work with no team in the shared _no-team folder', async () => {
    const { ok, cwd } = await readOnlyRunCwd('codex', null)

    expect(ok).toBe(true)
    expect(cwd).toBe(path.join(home, '.clawboo', 'workspaces', '_no-team'))
  })

  it("starts read-only Clawboo Native work in its team's folder too", async () => {
    const { ok, cwd } = await readOnlyRunCwd('clawboo-native', 'team-1')

    expect(ok).toBe(true)
    expect(cwd).toBe(path.join(home, '.clawboo', 'workspaces', 'team-1'))
  })

  it('gives a runtime with no folder (the mock harness) no cwd', async () => {
    const { ok, cwd } = await readOnlyRunCwd('clawboo-mock', 'team-1')

    expect(ok).toBe(true)
    expect(cwd ?? null).toBeNull()
  })

  it('refuses read-only work, rather than running in the server cwd, when its folder cannot be created', async () => {
    // getDb() creates the clawboo home; a file where workspaces/ should be.
    getDb()
    await writeFile(path.join(home, '.clawboo', 'workspaces'), 'not a folder')

    const { ok, fake } = await readOnlyRunCwd('claude-code', 'team-1')

    expect(ok).toBe(false)
    expect(fake.startCount).toBe(0)
  })

  it('releases the claim when the driver throws unexpectedly', async () => {
    const taskId = newTask()
    const fake = new ProbeAdapter('claude-code', true)

    await expect(
      runTaskOnRuntime({
        db: getDb(),
        makeAdapter: () => fake,
        taskId,
        assigneeAgentId: 'claude-1',
        disableMemoryAutoInject: true,
        kind: 'research',
      }),
    ).rejects.toThrow(/driver exploded/)

    // The throw propagates, but the task must not be left wedged in_progress.
    expect(getTask(getDb(), taskId)?.status).toBe('todo')
  })
})
