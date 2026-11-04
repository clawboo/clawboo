// A one-to-one turn's cost and budget hold. Every turn that calls a model writes
// one cost record (what Tokens Used reads), the way a team-chat run does, whether
// or not the agent has a budget. The turn holds its estimate on the agent's budget
// from the moment it is let start until it ends, so a turn going beside another run
// of the same agent cannot take a nearly spent hard cap past its limit.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  budgetReservations,
  chatMessages,
  costRecords,
  getBudget,
  recordSpend,
  reserveBudgets,
  setBudgetLimit,
  type ClawbooDb,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../../db'
import { directChatSessionKey, driveAgentChat } from '../driveAgentChat'

const CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
}
const base = (sk: string, seq: number) => ({ runId: sk, sessionId: sk, ts: seq, seq })

class FakeAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'fake'
  startCalls = 0
  constructor(
    private readonly gen: (run: RunHandle) => AsyncIterable<RuntimeEvent>,
    private readonly startError: Error | null = null,
  ) {}
  capabilities(): Capabilities {
    return CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startCalls += 1
    if (this.startError) throw this.startError
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    return this.gen(run)
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

describe('driveAgentChat: cost records and budget holds', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-agentchat-cost-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) {
      prev[k] = process.env[k]
      process.env[k] = home
    }
    db = getDb()
    expect(getDbPath().startsWith(home)).toBe(true)
  })
  afterEach(async () => {
    resetDb()
    for (const k of ['HOME', 'CLAWBOO_HOME']) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    await rm(home, { recursive: true, force: true })
  })

  function seedAgent(id: string, runtime: string): void {
    const now = Date.now()
    db.insert(agents)
      .values({
        id,
        name: id,
        gatewayId: id,
        sourceId: runtime,
        sourceAgentId: id,
        runtime,
        status: 'idle',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }
  const records = (agentId: string) =>
    db.select().from(costRecords).where(eq(costRecords.agentId, agentId)).all()
  const holds = () => db.select().from(budgetReservations).all()
  const chatRows = (sk: string) =>
    db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, sk))
      .all()
      .map((r) => JSON.parse(r.data as string) as { kind: string; role: string; text: string })

  it('a turn whose runtime reports its cost writes one record with that figure, with no budget', async () => {
    seedAgent('cc-x', 'claude-code')
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'text-delta',
          text: 'Hello',
          channel: 'assistant',
        }
        yield {
          ...base(run.sessionKey, 2),
          kind: 'cost',
          costUsd: 0.0125,
          usage: { inputTokens: 1200, outputTokens: 300 },
          model: 'claude-sonnet-4-6',
        }
        yield { ...base(run.sessionKey, 3), kind: 'done', reason: 'success', summary: 'Hello' }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'cc-x',
      message: 'hi',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })
    expect(records('cc-x')).toEqual([
      expect.objectContaining({
        model: 'claude-sonnet-4-6',
        inputTokens: 1200,
        outputTokens: 300,
        costUsd: 0.0125,
        sessionKey: directChatSessionKey('cc-x', 'claude-code'),
      }),
    ])
  })

  it('a turn whose runtime reports nothing writes one estimated record', async () => {
    seedAgent('hermes-x', 'hermes')
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'All done.' }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'hermes-x',
      message: 'please summarise the plan',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })
    const rows = records('hermes-x')
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.inputTokens).toBeGreaterThan(0)
    // The reply came in one piece, as the summary: it is the output that is priced.
    expect(row.outputTokens).toBe(Math.ceil('All done.'.length / 4))
    // At the default rate, $3 and $15 per million input and output tokens.
    expect(row.costUsd).toBeCloseTo((row.inputTokens * 3 + row.outputTokens * 15) / 1_000_000, 12)
  })

  it('a turn that never reached the model writes no record and leaves no hold', async () => {
    seedAgent('codex-x', 'codex')
    setBudgetLimit(db, { scope: 'agent', scopeId: 'codex-x', limitUsdCents: 1000, mode: 'cap' })
    const adapter = new FakeAdapter(
      () => (async function* () {})(),
      new Error('codex is not installed'),
    )
    await driveAgentChat({
      db,
      agentId: 'codex-x',
      message: 'hi',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })
    expect(adapter.startCalls).toBe(1)
    expect(records('codex-x')).toEqual([])
    expect(holds()).toEqual([])
  })

  it('holds the estimate while the turn runs and settles it to the real cost', async () => {
    seedAgent('cc-x', 'claude-code')
    setBudgetLimit(db, { scope: 'agent', scopeId: 'cc-x', limitUsdCents: 1000, mode: 'cap' })
    let heldDuringRun = -1
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        heldDuringRun = holds().length
        yield {
          ...base(run.sessionKey, 1),
          kind: 'cost',
          costUsd: 0.02,
          usage: { inputTokens: 10, outputTokens: 10 },
          model: 'claude-sonnet-4-6',
        }
        yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'ok' }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'cc-x',
      message: 'hi',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })
    expect(heldDuringRun).toBe(1)
    expect(holds()).toEqual([])
    expect(getBudget(db, 'agent', 'cc-x')?.spentMicroCents).toBe(2 * 10_000)
  })

  it('a turn beside another run of the agent is refused when the cap has no room for both', async () => {
    seedAgent('cc-x', 'claude-code')
    const sk = directChatSessionKey('cc-x', 'claude-code')
    setBudgetLimit(db, { scope: 'agent', scopeId: 'cc-x', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'cc-x', 90)
    // A team-chat run of the same agent is already going and holds 20 cents.
    const other = reserveBudgets(db, {
      scopes: [{ scope: 'agent', scopeId: 'cc-x' }],
      estimateCents: 20,
      runKind: 'team-chat',
    })
    expect(other.ok).toBe(true)
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'hi' }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'cc-x',
      message: 'hi',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })
    expect(adapter.startCalls).toBe(0)
    expect(chatRows(sk)).toEqual([
      expect.objectContaining({
        role: 'system',
        kind: 'meta',
        text: expect.stringContaining('runs already going have set aside the rest of it'),
      }),
    ])
    // Only the other run's hold is left.
    expect(holds()).toHaveLength(1)
  })

  it('the final gate refuses a turn whose cap paused while it got ready, and frees its hold', async () => {
    seedAgent('cc-x', 'claude-code')
    const sk = directChatSessionKey('cc-x', 'claude-code')
    setBudgetLimit(db, { scope: 'agent', scopeId: 'cc-x', limitUsdCents: 100, mode: 'cap' })
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'hi' }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'cc-x',
      message: 'hi',
      mcpBaseUrl: null,
      // The adapter is built once the turn has been let start; another run's spend
      // pauses the cap at that moment.
      makeAdapter: () => {
        recordSpend(db, 'agent', 'cc-x', 150)
        return adapter
      },
    })
    expect(adapter.startCalls).toBe(0)
    expect(chatRows(sk)).toEqual([
      expect.objectContaining({
        kind: 'meta',
        text: expect.stringContaining('The agent budget is paused at its hard cap'),
      }),
    ])
    expect(holds()).toEqual([])
  })

  it('a turn the server ends for going quiet frees its hold', async () => {
    seedAgent('hermes-q', 'hermes')
    setBudgetLimit(db, { scope: 'agent', scopeId: 'hermes-q', limitUsdCents: 1000, mode: 'cap' })
    const prevSilent = process.env['CLAWBOO_RUN_SILENT_TIMEOUT_MS']
    process.env['CLAWBOO_RUN_SILENT_TIMEOUT_MS'] = '20'
    try {
      let wake: () => void = () => undefined
      const quiet = new Promise<void>((res) => {
        wake = res
      })
      const adapter = new FakeAdapter((run) =>
        (async function* () {
          await quiet
          yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'aborted', summary: '' }
        })(),
      )
      // The watchdog ends the run by aborting it, while the turn still holds.
      let heldWhenEnded = -1
      adapter.abort = async () => {
        heldWhenEnded = holds().length
        wake()
      }
      await driveAgentChat({
        db,
        agentId: 'hermes-q',
        message: 'q',
        mcpBaseUrl: null,
        makeAdapter: () => adapter,
      })
      expect(heldWhenEnded).toBe(1)
      expect(holds()).toEqual([])
    } finally {
      if (prevSilent === undefined) delete process.env['CLAWBOO_RUN_SILENT_TIMEOUT_MS']
      else process.env['CLAWBOO_RUN_SILENT_TIMEOUT_MS'] = prevSilent
    }
  })

  it('a failed turn frees its hold', async () => {
    seedAgent('cc-x', 'claude-code')
    setBudgetLimit(db, { scope: 'agent', scopeId: 'cc-x', limitUsdCents: 1000, mode: 'cap' })
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'error',
          code: 'authentication_failed',
          message: 'no key',
          fatal: true,
        }
      })(),
    )
    await driveAgentChat({
      db,
      agentId: 'cc-x',
      message: 'hi',
      mcpBaseUrl: null,
      makeAdapter: () => adapter,
    })
    expect(holds()).toEqual([])
  })
})
