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

import {
  agents,
  costRecords,
  createTask,
  getBudget,
  getComments,
  listExecutions,
  setBudgetLimit,
} from '@clawboo/db'
import { DEFAULT_AGENT_CONFIG } from '@clawboo/adapter-native'
import { eq } from 'drizzle-orm'
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
const { saveAgentConfig } = await import('../runtimes/native/agentConfigStore')

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
  aborts = 0
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
  async abort() {
    this.aborts += 1
  }
  async setModel() {}
  async writeContext() {}
}

/** Reports a cost, then goes quiet until it is aborted, then ends on `done: aborted`. */
class QuietAfterCostAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'codex'
  aborts = 0
  private wake: () => void = () => {}
  private readonly aborted = new Promise<void>((resolve) => {
    this.wake = resolve
  })
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
    const aborted = this.aborted
    const base = (seq: number) => ({ runId: 'rid-0', sessionId: run.sessionKey, ts: 1, seq })
    return (async function* () {
      yield {
        ...base(1),
        kind: 'cost',
        costUsd: 0.5,
        usage: { inputTokens: 10, outputTokens: 5 },
        model: 'm',
      } as RuntimeEvent
      await aborted
      yield { ...base(2), kind: 'done', reason: 'aborted', summary: '' } as RuntimeEvent
    })()
  }
  async abort() {
    this.aborts += 1
    this.wake()
  }
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

describe('executor runner: what a run is charged, and when a cap stops it', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-charge-home-'))
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

  function newTask(title = 'Look something up'): string {
    return createTask(getDb(), {
      title,
      description: 'read-only',
      status: 'todo',
      teamId: 'team-1',
    }).id
  }

  function capAgent(agentId: string): void {
    setBudgetLimit(getDb(), { scope: 'agent', scopeId: agentId, limitUsdCents: 1, mode: 'cap' })
  }

  function run(taskId: string, adapter: RuntimeAdapter, agentId = 'cc-1', model?: string) {
    return runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: agentId,
      disableMemoryAutoInject: true,
      kind: 'research',
      budgetStopGraceMs: 20,
      ...(model ? { model } : {}),
    })
  }

  it('estimates a run that reported no cost from its text, like team chat does', async () => {
    setBudgetLimit(getDb(), {
      scope: 'agent',
      scopeId: 'cc-1',
      limitUsdCents: 100_000,
      mode: 'warn',
    })
    const taskId = newTask()
    // 40,000 characters of answer is about 10,000 tokens: 15 cents at the default rate.
    const answer = 'x'.repeat(40_000)
    const result = await run(
      taskId,
      new ScriptAdapter([{ kind: 'done', reason: 'success', summary: answer }]),
    )
    expect(result.ok).toBe(true)
    const [row] = listExecutions(getDb(), taskId)
    expect(row?.costSource).toBe('char-estimate')
    expect(row?.costUsd ?? 0).toBeGreaterThan(0.15)
    // The same estimate reached the budget, so a cap would engage on it.
    expect(getBudget(getDb(), 'agent', 'cc-1')?.spentUsdCents ?? 0).toBeGreaterThanOrEqual(15)
  })

  it('charges nothing for a run on a local Ollama model, and records it as local', async () => {
    capAgent('cc-1')
    const taskId = newTask()
    const adapter = new ScriptAdapter([
      {
        kind: 'cost',
        costUsd: 0,
        local: true,
        usage: { inputTokens: 40_000, outputTokens: 2_000 },
        model: 'llama3.2',
      },
      { kind: 'done', reason: 'success', summary: 'done locally' },
    ])
    await run(taskId, adapter)
    const [row] = listExecutions(getDb(), taskId)
    expect(row?.status).toBe('succeeded')
    expect(row?.costUsd).toBe(0)
    expect(row?.costSource).toBe('local')
    expect(getBudget(getDb(), 'agent', 'cc-1')?.status).not.toBe('paused')
  })

  it('does not charge the default rate when a run with no cost report was on an Ollama model', async () => {
    capAgent('codex-1')
    const taskId = newTask()
    await run(taskId, new SpendAdapter('codex', false), 'codex-1', 'ollama/llama3.2')
    const [row] = listExecutions(getDb(), taskId)
    expect(row?.costSource).toBe('local')
    expect(row?.costUsd).toBe(0)
    expect(getBudget(getDb(), 'agent', 'codex-1')?.spentUsdCents ?? 0).toBe(0)
  })

  it('prices a Native run with no model and no cost report at its configured Ollama model: free', async () => {
    saveAgentConfig(getDb(), {
      ...DEFAULT_AGENT_CONFIG,
      id: 'native-1',
      name: 'Local',
      primaryProvider: 'ollama',
      primaryModel: 'llama3.2',
      envVar: 'OLLAMA_BASE_URL',
      createdAt: 0,
      updatedAt: 0,
    })
    capAgent('native-1')
    const taskId = newTask()
    await run(taskId, new SpendAdapter('clawboo-native', false), 'native-1')
    const [row] = listExecutions(getDb(), taskId)
    expect(row?.costSource).toBe('local')
    expect(row?.costUsd).toBe(0)
    expect(getBudget(getDb(), 'agent', 'native-1')?.spentUsdCents ?? 0).toBe(0)
  })

  it('keeps a finished result whose final cost report crossed the cap, and refuses the next run', async () => {
    capAgent('cc-1')
    const taskId = newTask()
    const adapter = new ScriptAdapter([
      { kind: 'cost', costUsd: 0.5, usage: { inputTokens: 10, outputTokens: 5 }, model: 'm' },
      { kind: 'done', reason: 'success', summary: 'the finished answer' },
    ])
    const result = await run(taskId, adapter)
    expect(result.ok && result.doneReason).toBe('success')
    expect(adapter.aborts).toBe(0)
    const [row] = listExecutions(getDb(), taskId)
    expect(row?.status).toBe('succeeded')
    expect(row?.costUsd).toBeCloseTo(0.5, 12)
    const comments = getComments(getDb(), taskId).map((c) => c.body)
    expect(comments).toContain('the finished answer')
    expect(comments.some((c) => c.startsWith('Budget cap reached (agent)'))).toBe(true)
    expect(getBudget(getDb(), 'agent', 'cc-1')?.status).toBe('paused')

    const next = await run(
      newTask('next'),
      new ScriptAdapter([{ kind: 'done', reason: 'success', summary: 'x' }]),
    )
    expect(next.ok).toBe(false)
    if (next.ok) return
    expect(next.reason).toBe('budget_paused')
  })

  it('still stops a run whose cost report crossed the cap when it keeps working', async () => {
    capAgent('cc-1')
    const taskId = newTask()
    const adapter = new ScriptAdapter([
      { kind: 'cost', costUsd: 0.5, usage: { inputTokens: 10, outputTokens: 5 }, model: 'm' },
      { kind: 'tool-call', toolCallId: 't1', name: 'read', input: {}, partial: false },
      { kind: 'done', reason: 'success', summary: 'should not be kept' },
    ])
    const result = await run(taskId, adapter)
    expect(result.ok && result.summary).toBe('auto-paused (budget)')
    expect(adapter.aborts).toBe(1)
    expect(listExecutions(getDb(), taskId)[0]?.status).toBe('cancelled')
    expect(getComments(getDb(), taskId).map((c) => c.body)).not.toContain('should not be kept')
  })

  it('aborts a run that goes quiet after its cost report crossed the cap', async () => {
    capAgent('codex-1')
    const taskId = newTask()
    const adapter = new QuietAfterCostAdapter()
    const result = await run(taskId, adapter, 'codex-1')
    expect(result.ok && result.summary).toBe('auto-paused (budget)')
    expect(adapter.aborts).toBeGreaterThanOrEqual(1)
    expect(listExecutions(getDb(), taskId)[0]?.status).toBe('cancelled')
  })

  it('lists the run in Tokens Used', async () => {
    const now = Date.now()
    getDb()
      .insert(agents)
      .values({
        id: 'cc-1',
        name: 'Coder',
        gatewayId: 'cc-1',
        runtime: 'claude-code',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    const taskId = newTask()
    await run(
      taskId,
      new ScriptAdapter([
        {
          kind: 'cost',
          costUsd: 0.25,
          usage: { inputTokens: 1_200, outputTokens: 300 },
          model: 'claude-sonnet-4-6',
        },
        { kind: 'done', reason: 'success', summary: 'ok' },
      ]),
    )
    const rows = getDb().select().from(costRecords).where(eq(costRecords.agentId, 'cc-1')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      model: 'claude-sonnet-4-6',
      inputTokens: 1_200,
      outputTokens: 300,
      costUsd: 0.25,
    })
  })
})
