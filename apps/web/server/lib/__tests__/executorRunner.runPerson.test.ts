// A task-runner run registers whose run it is when it starts, signs that onto its
// Tools URL, and forgets it when it ends: the login fill finds the person by it.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createTask } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import type { PersonRef } from '@clawboo/protocol'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../db'
import { runTaskOnRuntime } from '../executorRunner'
import { runPersonForRef, type RunPerson } from '../runPerson'
import type { RuntimeRunContext } from '../runtimes/types'
import { seedSandboxTeam } from './seedTeam'

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: false,
  resume: false,
  toolApproval: true,
  models: [],
}

const ADA = { id: 'user-ada', name: 'Ada', role: 'member' }
const BOB = { id: 'user-bob', name: 'Bob', role: null }
const AGENT = 'claude-1'

/** An adapter that, while its run is live, reads the run's person by its reference. */
class SeeingAdapter implements RuntimeAdapter {
  readonly id = 'claude-code'
  readonly participantKind = 'agent' as const
  ref: string | null = null
  seenDuringRun: RunPerson | null = null

  constructor(ctx: RuntimeRunContext) {
    this.ref = ctx.memoryScope?.boundRunRef ?? null
  }
  capabilities(): Capabilities {
    return CAPS
  }
  async health() {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.seenDuringRun = runPersonForRef(this.ref, AGENT)
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const base = { runId: run.sessionKey, sessionId: run.sessionKey, ts: 1 }
    return (async function* () {
      yield { ...base, seq: 1, kind: 'done', reason: 'success', summary: 'done' } as RuntimeEvent
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

describe("the task runner's run person", () => {
  let home: string
  const prev: Record<string, string | undefined> = {}

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-runner-person-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    for (const name of ['HOME', 'CLAWBOO_HOME']) prev[name] = process.env[name]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    seedSandboxTeam(home)
  })

  afterEach(async () => {
    resetDb()
    for (const [name, value] of Object.entries(prev)) {
      if (value === undefined) delete process.env[name]
      else process.env[name] = value
    }
    await rm(home, { recursive: true, force: true })
  })

  async function run(
    task: Parameters<typeof createTask>[1],
    startedBy?: PersonRef,
  ): Promise<SeeingAdapter> {
    const db = getDb()
    const t = createTask(db, { status: 'todo', teamId: 'team-1', ...task })
    let adapter: SeeingAdapter | null = null
    const result = await runTaskOnRuntime({
      db,
      makeAdapter: (ctx) => (adapter = new SeeingAdapter(ctx)),
      taskId: t.id,
      assigneeAgentId: AGENT,
      kind: 'research',
      mcpBaseUrl: 'http://localhost:18790',
      ...(startedBy ? { startedBy } : {}),
    })
    expect(result.ok).toBe(true)
    if (!adapter) throw new Error('no adapter was made')
    return adapter
  }

  it('is the person who pressed Retry or Assign, over who asked for the task', async () => {
    const a = await run({ title: 'retried', requestedBy: ADA }, BOB)
    expect(a.ref).toBeTruthy()
    expect(a.seenDuringRun).toEqual({ person: BOB, basis: 'started' })
    // Forgotten once the run ends.
    expect(runPersonForRef(a.ref, AGENT)).toBeNull()
  })

  it('is who asked for the task when no one started it by hand', async () => {
    const a = await run({ title: 'asked', requestedBy: ADA })
    expect(a.seenDuringRun).toEqual({ person: ADA, basis: 'task_requester' })
  })

  it("is no one for a routine's task", async () => {
    const a = await run({ title: 'nightly', scheduledBy: 'routine-1' })
    expect(a.seenDuringRun).toEqual({ person: null, basis: 'none' })
  })
})
