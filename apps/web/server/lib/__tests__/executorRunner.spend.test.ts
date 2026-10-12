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

import { createTask, listExecutions } from '@clawboo/db'
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
const { estimateRunCostUsdFromUsage } = await import('../runtimes/estimateCost')

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

/** Emits a fixed script of events, each given the run's envelope. */
class ScriptAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'claude-code'
  constructor(private readonly script: Array<Record<string, unknown>>) {}
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
    const script = this.script
    return (async function* () {
      let seq = 0
      for (const e of script) {
        seq += 1
        yield {
          runId: run.runId ?? run.sessionKey,
          sessionId: run.sessionKey,
          ts: 1,
          seq,
          ...e,
        } as RuntimeEvent
      }
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

describe('executor runner: what the run cost, on its ledger row', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-run-cost-home-'))
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

  /** Run a fresh task on a scripted adapter; return its single ledger row. */
  async function runScript(script: Array<Record<string, unknown>>) {
    const taskId = createTask(getDb(), {
      title: 'Look something up',
      description: 'read-only',
      status: 'todo',
      teamId: 'team-1',
    }).id
    await runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => new ScriptAdapter(script),
      taskId,
      assigneeAgentId: 'cc-1',
      disableMemoryAutoInject: true,
      kind: 'research',
    })
    const rows = listExecutions(getDb(), taskId)
    expect(rows).toHaveLength(1)
    return rows[0]!
  }
  const usageEvent = { kind: 'cost', costUsd: null, estimated: true, model: 'm' }

  it('sums every token-estimated cost event instead of keeping the last one', async () => {
    const usage = { inputTokens: 1_000, outputTokens: 100 }
    const row = await runScript([
      { ...usageEvent, usage },
      { ...usageEvent, usage },
      { kind: 'done', reason: 'success', summary: 'ok' },
    ])
    const each = estimateRunCostUsdFromUsage({ model: 'm', ...usage })
    expect(each).toBeGreaterThan(0)
    expect(row.status).toBe('succeeded')
    expect(row.costUsd).toBeCloseTo(2 * each, 12)
    expect(row.costSource).toBe('token-estimate')
  })

  it("does not count a done's cost again when the cost event already reported it", async () => {
    const row = await runScript([
      { kind: 'cost', costUsd: 0.5, usage: { inputTokens: 10, outputTokens: 5 }, model: 'm' },
      { kind: 'done', reason: 'success', summary: 'ok', costUsd: 0.5 },
    ])
    expect(row.costUsd).toBeCloseTo(0.5, 12)
    expect(row.costSource).toBe('reported')
  })

  it('keeps the tokens of a run that failed', async () => {
    const row = await runScript([
      { kind: 'cost', costUsd: 0.02, usage: { inputTokens: 100, outputTokens: 20 }, model: 'm' },
      { kind: 'done', reason: 'error', summary: 'upstream provider error' },
    ])
    expect(row.status).toBe('failed')
    expect(row.inputTokens).toBe(100)
    expect(row.outputTokens).toBe(20)
    expect(row.costUsd).toBeCloseTo(0.02, 12)
    expect(row.costSource).toBe('reported')
  })
})
