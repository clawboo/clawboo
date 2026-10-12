// What a team run cost, once the real pieces have closed it. Wires the REAL engine
// (createBoardOrchestrator), the REAL run primitive (createServerDeliver) and the
// REAL board (createServerBoardClient over sqlite) the way codexLeaderCascade.test.ts
// does, with scripted codex-shaped adapters, and runs a person-assigned task through
// `dispatchTask`.
//
// The drain prices each run once, when it ends, and records the cost on the run's
// own execution row. These scenarios prove the engine's own close (a success, a
// failure, a Stop that closes the row before the run's terminal) leaves that cost in
// place, and that the task's cost is the sum of every run it had.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeHumanAssignment } from '@clawboo/board-core'
import {
  agents,
  createTask,
  getTask,
  listExecutions,
  runCostForTask,
  teams,
  updateStatus,
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
  agentIdFromSessionKey,
  buildTeamSessionKey,
  createBoardOrchestrator,
  createNudgeQueue,
  DELEGATION_IDLE_TIMEOUT_MS,
  REFLECT_WINDOW_MS,
  type BoardOrchestrator,
} from '@clawboo/team-orchestration'

import { getDb, resetDb } from '../../db'
import { estimateRunCostUsdFromUsage } from '../../runtimes/estimateCost'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'

const TEAM = 'T'
const LEAD = 'codex-lead'
const WORKER = 'codex-worker'

const CODEX_CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
  runtimeClass: 'wrapped-oneshot',
}

/** A script step: an event to yield, or a wait before the next one. */
type Step = RuntimeEvent | (() => Promise<void>)

/** A codex-shaped scripted adapter: each start() consumes the agent's next script. */
class ScriptedCodex implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'codex'
  readonly startOpts: StartOpts[] = []
  constructor(private readonly scripts: Step[][]) {}
  capabilities(): Capabilities {
    return CODEX_CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startOpts.push(opts)
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const script = this.scripts.shift() ?? []
    const sk = run.sessionKey
    return (async function* () {
      let seq = 0
      for (const step of script) {
        if (typeof step === 'function') {
          await step()
          continue
        }
        seq += 1
        yield { ...step, runId: sk, sessionId: sk, ts: seq, seq } as RuntimeEvent
      }
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

const ev = (e: Record<string, unknown>): RuntimeEvent => e as unknown as RuntimeEvent
const textDelta = (text: string): RuntimeEvent =>
  ev({ kind: 'text-delta', text, channel: 'assistant' })
const doneEv = (reason: string, summary: string, costUsd?: number): RuntimeEvent =>
  ev({ kind: 'done', reason, summary, ...(costUsd !== undefined ? { costUsd } : {}) })
const fatal = (message: string): RuntimeEvent =>
  ev({ kind: 'error', code: 'boom', message, fatal: true })

/** Advance fake time in small steps, with real macrotask turns between them so the
 *  drains' sqlite and fs work keeps pace, until `until()` holds (see the same helper
 *  in codexLeaderCascade.test.ts). */
async function settle(until: () => boolean, budgetMs = 30 * REFLECT_WINDOW_MS): Promise<void> {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  }
  for (let t = 0; t < budgetMs && !until(); t += 250) {
    await vi.advanceTimersByTimeAsync(250)
    await flush()
  }
  await flush()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

describe('team run cost (real engine + real drain + real board)', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    // Only the timers the engine batches on are fake; setImmediate stays real so
    // the drains' sqlite and fs work completes between fake-time steps.
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-run-cost-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: TEAM,
        name: 'Cost Team',
        icon: '🚀',
        color: '#e94560',
        leaderAgentId: LEAD,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values(
        [LEAD, WORKER].map((id) => ({
          id,
          name: id === LEAD ? 'Codex Lead' : 'Codex Worker',
          gatewayId: id,
          sourceId: 'codex',
          runtime: 'codex',
          teamId: TEAM,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run()
  })
  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  /** The engine and run primitive wired together, with the worker's scripts. The
   *  lead gets quiet turns, in case a run's outcome is reported to it. */
  function harness(workerScripts: Step[][]): {
    engine: BoardOrchestrator
    worker: ScriptedCodex
    stopGen: { value: number }
    clock: { value: number }
  } {
    const worker = new ScriptedCodex(workerScripts)
    const lead = new ScriptedCodex([[doneEv('success', 'noted')], [doneEv('success', 'noted')]])
    const stopGen = { value: 0 }
    // The engine's clock, so a test can age a run past the idle watchdog.
    const clock = { value: Date.now() }
    const engineRef: { current: BoardOrchestrator | null } = { current: null }
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      nudge: createNudgeQueue(),
      abortMap: new Map<string, RunEntry>(),
      onEvent: (sk, e, run) => engineRef.current!.onEvent(sk, e, run),
      onSessionClosed: (sk, run) => engineRef.current!.onSessionClosed(sk, run),
      taskForSession: (sk) => engineRef.current!.taskForSession(sk),
      execForSession: (sk) => engineRef.current!.execForSession(sk),
      stopGen: () => stopGen.value,
      leaderAgentId: () => LEAD,
      persistTurn: () => true,
      makeAdapterForAgent: (agentId) => (agentId === WORKER ? worker : lead),
    })
    const engine = createBoardOrchestrator({
      teamId: TEAM,
      board: createServerBoardClient(db),
      known: () => [
        { id: LEAD, name: 'Codex Lead' },
        { id: WORKER, name: 'Codex Worker' },
      ],
      leaderAgentId: () => LEAD,
      sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
      agentIdForSession: (sk) => agentIdFromSessionKey(sk),
      deliver,
      stopGen: () => stopGen.value,
      caps: { maxFanout: 8 },
      now: () => clock.value,
    })
    engineRef.current = engine
    return { engine, worker, stopGen, clock }
  }

  /** A task a person assigned to the worker, ready to run. */
  const assignTask = (): string =>
    createTask(db, {
      title: 'Parse the CSV',
      teamId: TEAM,
      status: 'todo',
      sourceDelegationId: encodeHumanAssignment(WORKER, 'n1'),
    }).id
  const rowsOf = (taskId: string) => listExecutions(db, taskId)
  /** True once the task's run `n` has left `running` and carries a cost. */
  const runClosedAndCosted = (taskId: string, n: number) => (): boolean => {
    const row = rowsOf(taskId)[n]
    return row !== undefined && row.status !== 'running' && row.costUsd != null
  }

  it("a success keeps the drain's token estimate on the row the engine closed", async () => {
    const usage = { inputTokens: 24_000, outputTokens: 4_000 }
    const h = harness([
      [
        ev({ kind: 'cost', costUsd: null, estimated: true, usage, model: 'gpt-4o' }),
        doneEv('success', 'parser written'),
      ],
    ])
    const id = assignTask()
    expect(await h.engine.dispatchTask(id)).toBe('started')
    await settle(() => runClosedAndCosted(id, 0)() && getTask(db, id)?.status === 'done')

    const expected = estimateRunCostUsdFromUsage({ model: 'gpt-4o', ...usage })
    const [row] = rowsOf(id)
    expect(row!.status).toBe('succeeded')
    expect(row!.costUsd).toBeCloseTo(expected, 12)
    expect(row!.costSource).toBe('token-estimate')
    expect(row!.inputTokens).toBe(24_000)
    expect(row!.outputTokens).toBe(4_000)
    expect(row!.runtime).toBe('codex')
    expect(getTask(db, id)!.costUsd).toBeCloseTo(expected, 12)
    expect(runCostForTask(db, id)).toEqual({ usd: row!.costUsd, estimated: true })
  })

  it('a fatal error leaves a failed run that still records what it cost', async () => {
    const h = harness([
      [textDelta('partial'), fatal('the model crashed'), doneEv('error', 'the model crashed')],
    ])
    const id = assignTask()
    expect(await h.engine.dispatchTask(id)).toBe('started')
    await settle(() => runClosedAndCosted(id, 0)() && getTask(db, id)?.status === 'blocked')

    const [row] = rowsOf(id)
    expect(row!.status).toBe('failed')
    expect(row!.costSource).toBe('char-estimate')
    expect(row!.costUsd).toBeGreaterThan(0)
    const task = getTask(db, id)!
    expect(task.status).toBe('blocked')
    expect(task.costUsd).toBeCloseTo(row!.costUsd!, 12)
  })

  it('a user Stop closes the row first, and the run still records its cost on it', async () => {
    const gate = deferred()
    const h = harness([
      [textDelta('working on it'), () => gate.promise, doneEv('aborted', 'working on it')],
    ])
    const id = assignTask()
    expect(await h.engine.dispatchTask(id)).toBe('started')
    await settle(() => h.worker.startOpts.length === 1)

    // The person presses Stop while the run is still going.
    h.stopGen.value += 1
    await h.engine.markStopped()
    const stopped = rowsOf(id)[0]!
    expect(stopped.status).toBe('cancelled')
    expect(stopped.costUsd).toBeNull()

    // The run's own terminal arrives after the Stop closed its row.
    gate.resolve()
    await settle(runClosedAndCosted(id, 0))

    const rows = rowsOf(id)
    expect(rows).toHaveLength(1)
    const row = rows[0]!
    expect(row.status).toBe('cancelled')
    expect(row.completedAt).toBe(stopped.completedAt)
    expect(row.costSource).toBe('char-estimate')
    expect(row.costUsd).toBeGreaterThan(0)
    const task = getTask(db, id)!
    expect(task.status).toBe('todo')
    expect(task.costUsd).toBeCloseTo(row.costUsd!, 12)
  })

  it('a run the idle watchdog already failed records its cost on that same row', async () => {
    const gate = deferred()
    const h = harness([
      [textDelta('working on it'), () => gate.promise, doneEv('aborted', 'working on it')],
    ])
    const id = assignTask()
    expect(await h.engine.dispatchTask(id)).toBe('started')
    await settle(() => h.worker.startOpts.length === 1)
    const sk = buildTeamSessionKey(WORKER, TEAM)!

    // The run goes quiet past the watchdog, which fails the task and forgets the
    // session, so the engine no longer names the run's row.
    h.clock.value += DELEGATION_IDLE_TIMEOUT_MS + 60_000
    await h.engine.sweepStaleSessions()
    const timedOut = rowsOf(id)[0]!
    expect(timedOut.status).not.toBe('running')
    expect(h.engine.execForSession(sk)).toBeNull()

    // The run's own terminal arrives late. The row was named at deliver time.
    gate.resolve()
    await settle(runClosedAndCosted(id, 0))

    const rows = rowsOf(id)
    expect(rows).toHaveLength(1)
    expect(rows[0]!.status).toBe(timedOut.status)
    expect(rows[0]!.completedAt).toBe(timedOut.completedAt)
    expect(rows[0]!.costUsd).toBeGreaterThan(0)
    expect(getTask(db, id)!.costUsd).toBeCloseTo(rows[0]!.costUsd!, 12)
  })

  it("a re-fired task's cost is the sum of both runs", async () => {
    const usage = { inputTokens: 1_000, outputTokens: 200 }
    const h = harness([
      [textDelta('partial'), fatal('the model crashed'), doneEv('error', 'the model crashed')],
      [
        ev({ kind: 'cost', costUsd: 0.12, usage, model: 'claude-sonnet-4-6' }),
        doneEv('success', 'parser written', 0.12),
      ],
    ])
    const id = assignTask()
    expect(await h.engine.dispatchTask(id)).toBe('started')
    await settle(() => runClosedAndCosted(id, 0)() && getTask(db, id)?.status === 'blocked')
    const first = rowsOf(id)[0]!.costUsd!
    expect(first).toBeGreaterThan(0)

    // A person retries it.
    updateStatus(db, id, 'todo')
    expect(await h.engine.dispatchTask(id)).toBe('started')
    await settle(() => runClosedAndCosted(id, 1)() && getTask(db, id)?.status === 'done')

    const rows = rowsOf(id)
    expect(rows).toHaveLength(2)
    expect(rows[1]!.costUsd).toBeCloseTo(0.12, 12)
    expect(rows[1]!.costSource).toBe('reported')
    expect(getTask(db, id)!.costUsd).toBeCloseTo(first + 0.12, 12)
    const runCost = runCostForTask(db, id)!
    expect(runCost.usd).toBeCloseTo(first + 0.12, 12)
    expect(runCost.estimated).toBe(true)
  })
})
