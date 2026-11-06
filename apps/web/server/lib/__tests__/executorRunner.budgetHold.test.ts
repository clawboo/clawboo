// Budget holds on the task runner. Runs that start together against one nearly
// spent hard cap used to pass the spent-total check together and overshoot it
// together; now each holds its estimate from the moment it is let start, so only
// as many start as the cap has room for. The hold is checked again right before
// the model call, shrinks as the run's real spend is recorded, and is gone however
// the run ends. Driven against a real sqlite board with runtimes held mid-stream.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  budgetReservations,
  createTask,
  getBudget,
  getComments,
  getTask,
  listExecutions,
  recordSpend,
  reserveBudgets,
  setBudgetLimit,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, getDbPath, resetDb } from '../db'
import { runTaskOnRuntime, type RunTaskResult } from '../executorRunner'
import type { RuntimeRunContext } from '../runtimes/types'
import { createRunSlots, setRunSlotsForTests } from '../runSlots'
import { stopTaskRuns } from '../runStops'

// No worktree and an ephemeral home: this exercises the budget, not the workspace
// or the per-agent lock.
const CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
}

/** A runtime that streams once, reports `costUsd` (when given), then holds until
 *  it is finished or aborted. */
function heldAdapter(opts: { costUsd?: number; startError?: Error } = {}) {
  const state = {
    started: 0,
    aborted: false,
    finish: null as null | (() => void),
  }
  const adapter: RuntimeAdapter = {
    id: 'claude-code',
    participantKind: 'agent',
    capabilities: () => CAPS,
    async health() {
      return { ok: true }
    },
    async start(_t: TaskHandle, o: StartOpts): Promise<RunHandle> {
      state.started++
      if (opts.startError) throw opts.startError
      return { adapterId: 'claude-code', sessionKey: o.sessionKey, runId: null }
    },
    events(run: RunHandle): AsyncIterable<RuntimeEvent> {
      const b = () => ({ runId: run.sessionKey, sessionId: run.sessionKey, ts: 1, seq: 1 })
      return (async function* () {
        yield { ...b(), kind: 'text-delta', text: 'working', channel: 'assistant' } as RuntimeEvent
        if (opts.costUsd != null)
          yield {
            ...b(),
            kind: 'cost',
            costUsd: opts.costUsd,
            usage: { inputTokens: 10, outputTokens: 10 },
            model: 'claude-sonnet-4-6',
          } as RuntimeEvent
        await new Promise<void>((res) => {
          state.finish = res
        })
        yield {
          ...b(),
          kind: 'done',
          reason: state.aborted ? 'aborted' : 'success',
          summary: state.aborted ? '' : 'finished',
        } as RuntimeEvent
      })()
    },
    async abort() {
      state.aborted = true
      state.finish?.()
    },
    async setModel() {},
    async writeContext() {},
  }
  return { adapter, state }
}

async function until(cond: () => boolean): Promise<void> {
  while (!cond()) await new Promise((r) => setTimeout(r, 5))
}

describe('budget holds on the task runner', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-run-hold-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    for (const [k, v] of [
      ['HOME', home],
      ['CLAWBOO_HOME', path.join(home, '.clawboo')],
    ] as const) {
      prev[k] = process.env[k]
      process.env[k] = v
    }
    expect(getDbPath().startsWith(home)).toBe(true)
    setRunSlotsForTests(createRunSlots(4))
  })
  afterEach(async () => {
    setRunSlotsForTests(null)
    resetDb()
    for (const k of ['HOME', 'CLAWBOO_HOME']) {
      if (prev[k] === undefined) delete process.env[k]
      else process.env[k] = prev[k]
    }
    await rm(home, { recursive: true, force: true })
  })

  const newTask = (title: string): string =>
    createTask(getDb(), { title, description: 'do it', status: 'todo', teamId: 'team-1' }).id
  const holds = () => getDb().select().from(budgetReservations).all()

  const run = (
    taskId: string,
    agentId: string,
    makeAdapter: (ctx: RuntimeRunContext) => RuntimeAdapter,
  ): Promise<RunTaskResult> =>
    runTaskOnRuntime({
      db: getDb(),
      makeAdapter,
      taskId,
      assigneeAgentId: agentId,
      kind: 'research',
      disableMemoryAutoInject: true,
    })

  it('two runs against a nearly spent team cap: only one starts', async () => {
    const db = getDb()
    setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'team', 'team-1', 95)
    const first = heldAdapter()
    const second = heldAdapter()
    const taskA = newTask('first')
    const taskB = newTask('second')

    const pA = run(taskA, 'agent-a', () => first.adapter)
    await until(() => first.state.finish !== null)
    const resultB = await run(taskB, 'agent-b', () => second.adapter)

    // B would have taken the cap past its limit beside A: refused before its claim,
    // its card untouched.
    expect(resultB).toEqual({ ok: false, reason: 'budget_held' })
    expect(second.state.started).toBe(0)
    expect(getTask(db, taskB)?.status).toBe('todo')
    expect(listExecutions(db, taskB)).toEqual([])
    expect(holds()).toHaveLength(1)

    first.state.finish!()
    expect((await pA).ok).toBe(true)
    expect(holds()).toEqual([])
  })

  it('runs whose estimates fit under the cap start side by side', async () => {
    const db = getDb()
    setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 10_000, mode: 'cap' })
    const first = heldAdapter()
    const second = heldAdapter()
    const pA = run(newTask('first'), 'agent-a', () => first.adapter)
    await until(() => first.state.finish !== null)
    const pB = run(newTask('second'), 'agent-b', () => second.adapter)
    await until(() => second.state.finish !== null)
    expect(holds()).toHaveLength(2)
    first.state.finish!()
    second.state.finish!()
    expect((await pA).ok && (await pB).ok).toBe(true)
    expect(holds()).toEqual([])
  })

  it('a warn-only budget never refuses a parallel run', async () => {
    const db = getDb()
    setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 100, mode: 'warn' })
    recordSpend(db, 'team', 'team-1', 95)
    const first = heldAdapter()
    const second = heldAdapter()
    const pA = run(newTask('first'), 'agent-a', () => first.adapter)
    await until(() => first.state.finish !== null)
    const pB = run(newTask('second'), 'agent-b', () => second.adapter)
    await until(() => second.state.finish !== null)
    first.state.finish!()
    second.state.finish!()
    expect((await pA).ok && (await pB).ok).toBe(true)
  })

  it('settles the hold to the real cost when the run ends', async () => {
    const db = getDb()
    setBudgetLimit(db, { scope: 'agent', scopeId: 'agent-a', limitUsdCents: 1000, mode: 'cap' })
    const a = heldAdapter({ costUsd: 0.12 })
    const p = run(newTask('spend'), 'agent-a', () => a.adapter)
    await until(() => a.state.finish !== null)
    // The 50-cent estimate (no recorded runs yet) less the 12 cents already spent.
    expect(holds().map((h) => h.heldMicroCents)).toEqual([38 * 10_000])
    a.state.finish!()
    expect((await p).ok).toBe(true)
    expect(holds()).toEqual([])
    expect(getBudget(db, 'agent', 'agent-a')?.spentUsdCents).toBe(12)
  })

  it('the final gate refuses a run whose cap paused while it got ready', async () => {
    const db = getDb()
    setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 100, mode: 'cap' })
    const a = heldAdapter()
    const taskId = newTask('late pause')
    const result = await run(taskId, 'agent-a', (ctx) => {
      // The run's own adapter is built once it is claimed and its prompt is ready
      // (the first call is a capabilities probe). Another run's spend pauses the cap
      // at that moment.
      if (ctx.memoryScope) recordSpend(db, 'team', 'team-1', 150)
      return a.adapter
    })

    expect(result).toEqual({ ok: false, reason: 'budget_paused' })
    expect(a.state.started).toBe(0)
    expect(getTask(db, taskId)?.status).toBe('todo')
    expect(listExecutions(db, taskId).map((e) => [e.status, e.error, e.errorClass])).toEqual([
      ['cancelled', 'budget_paused:team', 'BudgetRefused'],
    ])
    expect(getComments(db, taskId).map((c) => c.body)).toEqual([
      expect.stringContaining('The team budget is paused at its hard cap'),
    ])
    expect(holds()).toEqual([])
  })

  it('the final gate refuses a run the cap can no longer hold beside another run', async () => {
    const db = getDb()
    setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 10_000, mode: 'cap' })
    const a = heldAdapter()
    const taskId = newTask('late squeeze')
    const result = await run(taskId, 'agent-a', (ctx) => {
      if (ctx.memoryScope) {
        // After this run was let start: another run starts beside it and holds half
        // the cap, then the cap is lowered (still active) so both no longer fit.
        expect(
          reserveBudgets(db, {
            scopes: [{ scope: 'team', scopeId: 'team-1' }],
            estimateCents: 5_000,
            runKind: 'team-chat',
          }).ok,
        ).toBe(true)
        setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 1_000 })
      }
      return a.adapter
    })

    expect(result).toEqual({ ok: false, reason: 'budget_held' })
    expect(a.state.started).toBe(0)
    expect(getTask(db, taskId)?.status).toBe('todo')
    expect(listExecutions(db, taskId).map((e) => [e.status, e.error])).toEqual([
      ['cancelled', 'budget_held:team'],
    ])
    expect(getComments(db, taskId).map((c) => c.body)).toEqual([
      expect.stringContaining('runs already going have set aside the rest of it'),
    ])
    // Only the other run's hold is left.
    expect(holds()).toHaveLength(1)
  })

  it('a run that would go on in a fresh session stops when another run paused its cap', async () => {
    const db = getDb()
    setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 100, mode: 'cap' })
    let starts = 0
    const adapter: RuntimeAdapter = {
      id: 'claude-code',
      participantKind: 'agent',
      capabilities: () => CAPS,
      async health() {
        return { ok: true }
      },
      async start(_t: TaskHandle, o: StartOpts): Promise<RunHandle> {
        starts++
        return { adapterId: 'claude-code', sessionKey: o.sessionKey, runId: null }
      },
      events(run: RunHandle): AsyncIterable<RuntimeEvent> {
        const b = () => ({ runId: run.sessionKey, sessionId: run.sessionKey, ts: 1, seq: 1 })
        return (async function* () {
          yield {
            ...b(),
            kind: 'cost',
            costUsd: 0.01,
            usage: { inputTokens: 10, outputTokens: 10 },
            model: 'claude-sonnet-4-6',
          } as RuntimeEvent
          // A teammate's run pauses the team's cap while this pass is going.
          recordSpend(db, 'team', 'team-1', 150)
          // The pass runs out of turns, which would rotate it to a fresh session.
          yield { ...b(), kind: 'done', reason: 'max_turns', summary: 'half way' } as RuntimeEvent
        })()
      },
      async abort() {},
      async setModel() {},
      async writeContext() {},
    }
    const taskId = newTask('long one')
    const result = await run(taskId, 'agent-a', () => adapter)

    expect(starts).toBe(1)
    expect(result).toMatchObject({ ok: true, doneReason: 'aborted', status: 'todo' })
    expect(listExecutions(db, taskId).map((e) => [e.status, e.error, e.errorClass])).toEqual([
      ['cancelled', 'budget_paused:team', 'BudgetRefused'],
    ])
    expect(holds()).toEqual([])
  })

  it('a run whose start throws leaves no hold', async () => {
    const db = getDb()
    setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 1000, mode: 'cap' })
    const a = heldAdapter({ startError: new Error('spawn failed') })
    await expect(run(newTask('broken'), 'agent-a', () => a.adapter)).rejects.toThrow('spawn failed')
    expect(holds()).toEqual([])
  })

  it('a run a person stops leaves no hold', async () => {
    const db = getDb()
    setBudgetLimit(db, { scope: 'team', scopeId: 'team-1', limitUsdCents: 1000, mode: 'cap' })
    const a = heldAdapter()
    const taskId = newTask('stopped')
    const p = run(taskId, 'agent-a', () => a.adapter)
    await until(() => a.state.finish !== null)
    expect(holds()).toHaveLength(1)
    expect(stopTaskRuns(taskId, 'Stopped: a person moved the card to Done.')).toBe(true)
    await p
    expect(a.state.aborted).toBe(true)
    expect(holds()).toEqual([])
  })
})
