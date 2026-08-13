/**
 * Unreported-spend visibility.
 *
 * Codex and Hermes only emit a cost event `if (ev.usage)`, so a change in a CLI's
 * output format stops spend reaching the budget ledger without failing anything:
 * budgets and caps quietly under-count real money. The runner therefore warns when
 * a pass finishes without reporting any usage or cost.
 */

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { createTask } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'

// Narrow mock: keep every other obs export real, spy only on the structured logger.
const logStructured = vi.fn()
vi.mock('../obs', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../obs')>()),
  logStructured: (entry: unknown) => logStructured(entry),
}))

const { getDb, resetDb } = await import('../db')
const { runTaskOnRuntime } = await import('../executorRunner')

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
  contextWindowTokens: 200_000,
}

/** Emits a terminal, optionally preceded by a cost event. */
class SpendAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  constructor(
    readonly id: string,
    private readonly reportsCost: boolean,
  ) {}
  capabilities(): Capabilities {
    return CAPS
  }
  async health() {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: 'rid-0' }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const reports = this.reportsCost
    let seq = 0
    const base = () => ({
      runId: run.runId ?? run.sessionKey,
      sessionId: run.sessionKey,
      ts: 1,
      seq: (seq += 1),
    })
    return (async function* () {
      if (reports) {
        yield {
          ...base(),
          kind: 'cost',
          costUsd: 0.01,
          usage: { inputTokens: 10, outputTokens: 5 },
          model: 'm',
        } as RuntimeEvent
      }
      yield { ...base(), kind: 'done', reason: 'success', summary: 'ok' } as RuntimeEvent
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

const spendWarnings = (): unknown[] =>
  logStructured.mock.calls
    .map((c) => c[0] as { action?: string })
    .filter((e) => e?.action === 'spend_unreported')

describe('executor runner — unreported spend is visible', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    logStructured.mockClear()
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-spend-home-'))
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
      title: 'Look something up',
      description: 'read-only',
      status: 'todo',
      teamId: 'team-1',
    }).id
  }

  it('warns when a run reports no usage or cost at all', async () => {
    const result = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => new SpendAdapter('codex', false),
      taskId: newTask(),
      assigneeAgentId: 'codex-1',
      disableMemoryAutoInject: true,
      kind: 'research',
    })

    expect(result.ok).toBe(true)
    const warned = spendWarnings()
    expect(warned).toHaveLength(1)
    expect(warned[0]).toMatchObject({ level: 'warn', runtime: 'codex' })
  })

  it('stays quiet when the runtime does report cost', async () => {
    const result = await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => new SpendAdapter('codex', true),
      taskId: newTask(),
      assigneeAgentId: 'codex-1',
      disableMemoryAutoInject: true,
      kind: 'research',
    })

    expect(result.ok).toBe(true)
    expect(spendWarnings()).toHaveLength(0)
  })
})
