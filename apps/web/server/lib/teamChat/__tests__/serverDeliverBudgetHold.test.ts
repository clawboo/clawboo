// Budget holds on team-chat deliveries. Two teammates' runs that start together
// against one nearly spent team hard cap used to pass the paused-only check
// together and overshoot it together; now the first holds its estimate and the
// second is refused, with the reason in the chat. The hold is checked again right
// before the model call and is gone however the run ends.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  budgetReservations,
  claimTask,
  createTask,
  getBudget,
  jobRunState,
  recordSpend,
  listGovernanceAudit,
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
import {
  createNudgeQueue,
  DeliveryRefusedError,
  HUMAN_TURN,
  type RunStamp,
  type TurnOrigin,
} from '@clawboo/team-orchestration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { estimateRunReserveCents, reserveRunBudget } from '../../budgetHold'
import { getDb, getDbPath, resetDb } from '../../db'
import { createServerDeliver, type RunEntry } from '../serverDeliver'

/** Runs between the budget gate and the final gate, when a test sets it: the
 *  moment another run's spend can land while this one gets ready. */
const beforeFinalGate: { fn: (() => void) | null } = { fn: null }
vi.mock('../../budgetHold', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../budgetHold')>()
  return {
    ...real,
    reserveRunBudget: (...args: Parameters<typeof real.reserveRunBudget>) => {
      const gate = real.reserveRunBudget(...args)
      if (gate.blocked) return gate
      const { hold } = gate
      return {
        blocked: false,
        hold: {
          id: hold.id,
          release: () => hold.release(),
          recheck: () => {
            beforeFinalGate.fn?.()
            return hold.recheck()
          },
        },
      }
    },
  }
})

// Ephemeral home: no per-agent lock, so two agents' runs go side by side.
const CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
}
const base = (sk: string, seq: number) => ({ runId: sk, sessionId: sk, ts: seq, seq })
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

class HeldAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'claude-code'
  startCalls = 0
  release: (() => void) | null = null
  constructor(
    private readonly ending: 'done' | 'no-terminal' = 'done',
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
    const ending = this.ending
    return (async function* (self: HeldAdapter) {
      yield { ...base(run.sessionKey, 1), kind: 'text-delta', text: 'hi', channel: 'assistant' }
      await new Promise<void>((res) => {
        self.release = res
      })
      if (ending === 'done')
        yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'hi' }
    })(this) as AsyncIterable<RuntimeEvent>
  }
  async abort(): Promise<void> {
    this.release?.()
  }
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

describe('serverDeliver: budget holds', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-deliver-hold-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) {
      prev[k] = process.env[k]
      process.env[k] = home
    }
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    beforeFinalGate.fn = null
  })
  afterEach(async () => {
    resetDb()
    for (const k of ['HOME', 'CLAWBOO_HOME']) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    await rm(home, { recursive: true, force: true })
  })

  const holds = () => db.select().from(budgetReservations).all()

  function wire(adapters: Record<string, RuntimeAdapter>) {
    const metas: Array<{ sk: string; text: string }> = []
    const closed: string[] = []
    const notStarted: RunStamp[] = []
    const deliver = createServerDeliver({
      db,
      teamId: 'T',
      mcpBaseUrl: null,
      nudge: createNudgeQueue(),
      abortMap: new Map<string, RunEntry>(),
      onEvent: async () => undefined,
      onSessionClosed: async (sk) => {
        closed.push(sk)
      },
      taskForSession: () => null,
      execForSession: () => null,
      stopGen: () => 0,
      leaderAgentId: () => 'a1',
      persistTurn: () => true,
      persistMeta: (sk, text) => {
        metas.push({ sk, text })
        return true
      },
      makeAdapterForAgent: (agentId: string) => adapters[agentId]!,
      onRunNotStarted: (run) => {
        notStarted.push(run)
      },
    })
    return { deliver, metas, closed, notStarted }
  }
  const sk = (agentId: string) => `agent:${agentId}:team:T`

  it('two teammates against a nearly spent team cap: only the first run starts', async () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'team', 'T', 95)
    const a1 = new HeldAdapter()
    const a2 = new HeldAdapter()
    const w = wire({ a1, a2 })

    await w.deliver(sk('a1'), 'a1', 'first', HUMAN_TURN)
    await vi.waitFor(() => expect(a1.release).not.toBeNull())
    const err = await w.deliver(sk('a2'), 'a2', 'second', HUMAN_TURN).catch((e: unknown) => e)

    expect(err).toBeInstanceOf(DeliveryRefusedError)
    expect((err as Error).message).toMatch(/runs already going have set aside the rest of it/)
    expect(a2.startCalls).toBe(0)
    expect(w.metas).toEqual([{ sk: sk('a2'), text: (err as Error).message }])
    expect(holds()).toHaveLength(1)

    a1.release!()
    await vi.waitFor(() => expect(holds()).toEqual([]))
  })

  it('a task update refused the same way says it goes out by itself, and a person’s turn says try again', async () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'team', 'T', 95)
    const a1 = new HeldAdapter()
    const a2 = new HeldAdapter()
    const w = wire({ a1, a2 })
    await w.deliver(sk('a1'), 'a1', 'first', HUMAN_TURN)
    await vi.waitFor(() => expect(a1.release).not.toBeNull())

    const update = await w
      .deliver(sk('a2'), 'a2', '[Task Update]', { kind: 'system' })
      .catch((e: unknown) => e)
    expect(update).toBeInstanceOf(DeliveryRefusedError)
    expect((update as Error).message).toMatch(/It goes out by itself/)
    expect((update as Error).message).not.toMatch(/Try again/)

    const person = await w.deliver(sk('a2'), 'a2', 'second', HUMAN_TURN).catch((e: unknown) => e)
    expect((person as Error).message).toMatch(/Try again/)

    a1.release!()
    await vi.waitFor(() => expect(holds()).toEqual([]))
  })

  it('a task update refused behind its recipient’s run hands back what it carried as no try', async () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 100, mode: 'cap' })
    const a1 = new HeldAdapter()
    const w = wire({ a1 })
    await w.deliver(sk('a1'), 'a1', 'first', HUMAN_TURN)
    await vi.waitFor(() => expect(a1.release).not.toBeNull())
    // Another run sets aside what is left, and this one spends a little of it.
    const other = reserveRunBudget(
      db,
      { teamId: 'T' },
      { kind: 'team-chat', ref: 'other', estimateCents: 100 - estimateRunReserveCents(db, 'a1') },
    )
    expect(other.blocked).toBe(false)
    recordSpend(db, 'team', 'T', 1)

    await w.deliver(sk('a1'), 'a1', '[Task Update]', { kind: 'system', reportUpIds: ['r1'] })
    expect(w.notStarted).toEqual([])
    a1.release!()
    await vi.waitFor(() => expect(w.notStarted).toHaveLength(1))
    expect(w.notStarted[0]).toMatchObject({ reportUpIds: ['r1'], budgetHeld: true })
    if (!other.blocked) other.hold.release()
  })

  it('the final gate refuses a run whose cap paused while it got ready', async () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 100, mode: 'cap' })
    const a1 = new HeldAdapter()
    const w = wire({ a1 })
    beforeFinalGate.fn = () => recordSpend(db, 'team', 'T', 150)
    await expect(w.deliver(sk('a1'), 'a1', 'hi', HUMAN_TURN)).rejects.toThrow(
      /The team budget is paused at its hard cap/,
    )
    expect(a1.startCalls).toBe(0)
    expect(holds()).toEqual([])
  })

  describe('what a run takes from its job’s count', () => {
    const claimed = (): { taskId: string; execId: string } => {
      const task = createTask(db, {
        title: 'Its work',
        teamId: 'T',
        status: 'todo',
        sourceDelegationId: 'r:deleg:agent:a1:reflectTo:a1',
      })
      const claim = claimTask(db, task.id, 'a1', 'claude-code', {
        run: { executorType: 'openclaw', runReason: 'delegation' },
      })
      expect(jobRunState(db, task.id).runs).toBe(1)
      return { taskId: task.id, execId: claim.execution!.id }
    }
    const wireTask = (adapter: RuntimeAdapter, taskId: string, execId: string) =>
      createServerDeliver({
        db,
        teamId: 'T',
        mcpBaseUrl: null,
        nudge: createNudgeQueue(),
        abortMap: new Map<string, RunEntry>(),
        onEvent: async () => undefined,
        onSessionClosed: async () => undefined,
        taskForSession: () => taskId,
        execForSession: () => execId,
        stopGen: () => 0,
        leaderAgentId: () => 'a1',
        persistTurn: () => true,
        persistMeta: () => true,
        makeAdapterForAgent: () => adapter,
      })
    const taskOrigin: TurnOrigin = { kind: 'delegation', fromAgentId: 'a1' }

    it('goes back when the gate refuses the run before it starts', async () => {
      const { taskId, execId } = claimed()
      setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 100, mode: 'cap' })
      recordSpend(db, 'team', 'T', 150)
      const a1 = new HeldAdapter()
      await expect(wireTask(a1, taskId, execId)(sk('a1'), 'a1', 'hi', taskOrigin)).rejects.toThrow(
        /budget is paused/,
      )
      expect(a1.startCalls).toBe(0)
      expect(jobRunState(db, taskId).runs).toBe(0)
    })

    it('goes back when the final gate does', async () => {
      const { taskId, execId } = claimed()
      setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 100, mode: 'cap' })
      beforeFinalGate.fn = () => recordSpend(db, 'team', 'T', 150)
      const a1 = new HeldAdapter()
      await expect(wireTask(a1, taskId, execId)(sk('a1'), 'a1', 'hi', taskOrigin)).rejects.toThrow(
        /budget is paused/,
      )
      expect(a1.startCalls).toBe(0)
      expect(jobRunState(db, taskId).runs).toBe(0)
    })

    it('stays for a run that started', async () => {
      const { taskId, execId } = claimed()
      const a1 = new HeldAdapter()
      await wireTask(a1, taskId, execId)(sk('a1'), 'a1', 'hi', taskOrigin)
      expect(a1.startCalls).toBe(1)
      expect(jobRunState(db, taskId).runs).toBe(1)
      a1.release?.()
    })

    it('an update turn counts toward its jobs when it starts, and not before', async () => {
      const { taskId } = claimed()
      const origin: TurnOrigin = { kind: 'system', countJobs: [taskId] }
      setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 100, mode: 'cap' })
      recordSpend(db, 'team', 'T', 150)
      const refused = new HeldAdapter()
      await expect(wire({ a1: refused }).deliver(sk('a1'), 'a1', 'hi', origin)).rejects.toThrow(
        /budget is paused/,
      )
      expect(jobRunState(db, taskId).runs).toBe(1)

      setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 100_000, mode: 'cap' })
      const going = new HeldAdapter()
      await wire({ a1: going }).deliver(sk('a1'), 'a1', 'hi', origin)
      expect(going.startCalls).toBe(1)
      expect(jobRunState(db, taskId).runs).toBe(2)
      going.release?.()
    })
  })

  it('settles the hold when the run ends', async () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 10_000, mode: 'cap' })
    const a1 = new HeldAdapter()
    const w = wire({ a1 })
    await w.deliver(sk('a1'), 'a1', 'hi', HUMAN_TURN)
    await vi.waitFor(() => expect(a1.release).not.toBeNull())
    expect(holds()).toHaveLength(1)
    a1.release!()
    await vi.waitFor(() => expect(holds()).toEqual([]))
    // The estimate is gone; the run's priced cost stays.
    expect(getBudget(db, 'agent', 'a1')!.spentMicroCents).toBeGreaterThan(0)
  })

  describe('a team-chat run crossing a budget', () => {
    /** A run that reports what it cost, then ends. */
    class CostAdapter extends HeldAdapter {
      constructor(private readonly usd: number) {
        super()
      }
      override events(run: RunHandle): AsyncIterable<RuntimeEvent> {
        const usd = this.usd
        return (async function* (): AsyncGenerator<RuntimeEvent> {
          yield {
            ...base(run.sessionKey, 1),
            kind: 'cost',
            costUsd: usd,
            usage: { inputTokens: 10, outputTokens: 10 },
            model: 'claude-sonnet-4-6',
          }
          yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'ok' }
        })()
      }
    }
    const rows = () =>
      listGovernanceAudit(db, { eventType: 'budget' }).map((r) => ({
        agentId: r.agentId,
        teamId: r.teamId,
        summary: JSON.parse(r.summary) as Record<string, unknown>,
      }))
    const runOf = async (usd: number) => {
      const w = wire({ a1: new CostAdapter(usd) })
      await w.deliver(sk('a1'), 'a1', 'hi', HUMAN_TURN)
      // A run's hold goes when its cost has settled.
      await tick()
      await vi.waitFor(() => expect(holds()).toEqual([]))
    }

    it('writes a warning row per budget it crosses', async () => {
      setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 100, mode: 'warn' })
      setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 100, mode: 'warn' })
      await runOf(0.9)
      expect(
        rows()
          .map((r) => r.summary['scope'])
          .sort(),
      ).toEqual(['agent', 'team'])
      expect(rows().find((r) => r.summary['scope'] === 'team')).toMatchObject({
        agentId: 'a1',
        teamId: 'T',
        summary: { reason: 'warn', level: 'soft', scopeId: 'T', runKind: 'team-chat' },
      })
    })

    it('says a hard cap paused the budget', async () => {
      setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 100, mode: 'cap' })
      await runOf(1.5)
      expect(rows()).toHaveLength(1)
      expect(rows()[0]?.summary).toMatchObject({ reason: 'auto_pause', level: 'hard' })
    })

    it('writes nothing under the line', async () => {
      setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 10_000, mode: 'cap' })
      await runOf(0.1)
      expect(rows()).toEqual([])
    })
  })

  it('a run whose start throws leaves no hold', async () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 1000, mode: 'cap' })
    const a1 = new HeldAdapter('done', new Error('spawn failed'))
    const w = wire({ a1 })
    await expect(w.deliver(sk('a1'), 'a1', 'hi', HUMAN_TURN)).rejects.toThrow('spawn failed')
    await tick()
    expect(holds()).toEqual([])
  })

  it('a stream that dies with no terminal leaves no hold', async () => {
    setBudgetLimit(db, { scope: 'team', scopeId: 'T', limitUsdCents: 1000, mode: 'cap' })
    const a1 = new HeldAdapter('no-terminal')
    const w = wire({ a1 })
    await w.deliver(sk('a1'), 'a1', 'hi', HUMAN_TURN)
    await vi.waitFor(() => expect(a1.release).not.toBeNull())
    a1.release!()
    await vi.waitFor(() => expect(w.closed).toEqual([sk('a1')]))
    expect(holds()).toEqual([])
  })
})
