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

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
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
