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
  getBudget,
  recordSpend,
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
import { createNudgeQueue, DeliveryRefusedError, HUMAN_TURN } from '@clawboo/team-orchestration'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

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
    db = getDb()
    expect(getDbPath().startsWith(home)).toBe(true)
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
    })
    return { deliver, metas, closed }
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
