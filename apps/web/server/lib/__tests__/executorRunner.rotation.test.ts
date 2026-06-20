// Session rotation + memory auto-injection, end to end through the runner.
// Drives runTaskOnRuntime against a REAL sqlite board (sandboxed $HOME), with a
// FAKE adapter that scripts a per-run terminal reason. Proves: a `max_turns` run
// rotates to a fresh successor session (carrying a handoff note) and continues to
// completion; the rotation is bounded by maxRotations; the sessions lineage +
// `session_rotated` obs event are written; cumulative budget spend persists across
// rotations; and the run-start memory block is injected (and suppressed when off).

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  SqliteMemoryStore,
  createDb,
  createTask,
  getBudget,
  getSessionBySourceId,
  getSessionLineage,
  listEvents,
  setBudgetLimit,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  SessionCodec,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'

import { getDbPath } from '../db'
import { runTaskOnRuntime } from '../executorRunner'

type Reason = 'success' | 'max_turns' | 'error'

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
  contextWindowTokens: 200_000,
}

/** Adapter that scripts a terminal reason PER run (keyed by start order), records
 *  every start's context + sessionKey, and counts sessionCodec.serialize calls. */
class RotatingAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  startCount = 0
  startedContexts: string[] = []
  startedSessionKeys: string[] = []
  serializeCount = 0
  private readonly reasonBySession = new Map<string, Reason>()

  constructor(
    readonly id: string,
    private readonly reasons: Reason[],
    private readonly costUsdPerRun = 0,
  ) {}

  readonly sessionCodec: SessionCodec = {
    serialize: async (run: RunHandle): Promise<string> => {
      this.serializeCount += 1
      return JSON.stringify({ sessionKey: run.sessionKey, sessionId: run.runId })
    },
    restore: async (blob: string): Promise<RunHandle> => {
      const p = JSON.parse(blob) as { sessionKey?: string; sessionId?: string | null }
      return { adapterId: this.id, sessionKey: p.sessionKey ?? '', runId: p.sessionId ?? null }
    },
  }

  capabilities(): Capabilities {
    return CAPS
  }
  async health() {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    const idx = this.startCount
    this.startCount += 1
    this.startedContexts.push(opts.context ?? '')
    this.startedSessionKeys.push(opts.sessionKey)
    this.reasonBySession.set(opts.sessionKey, this.reasons[idx] ?? 'success')
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: `rid-${idx}` }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const reason = this.reasonBySession.get(run.sessionKey) ?? 'success'
    const costUsd = this.costUsdPerRun
    let seq = 0
    const base = () => ({
      runId: run.runId ?? run.sessionKey,
      sessionId: run.sessionKey,
      ts: 1,
      seq: (seq += 1),
    })
    return (async function* () {
      if (costUsd > 0) {
        yield {
          ...base(),
          kind: 'cost',
          costUsd,
          usage: { inputTokens: 10, outputTokens: 10 },
          model: 'm',
        } as RuntimeEvent
      }
      yield { ...base(), kind: 'done', reason, summary: `summary:${reason}` } as RuntimeEvent
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

describe('executor runner — session rotation + memory injection', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-rot-home-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  function newTask(
    title = 'Implement payment processing',
    description = 'wire the Stripe path',
  ): string {
    return createTask(createDb(getDbPath()), {
      title,
      description,
      status: 'todo',
      teamId: 'team-1',
    }).id
  }

  it('rotates a max_turns run to a fresh session and completes on the successor', async () => {
    const taskId = newTask()
    const fake = new RotatingAdapter('claude-code', ['max_turns', 'success'])
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'claude-1',
      disableMemoryAutoInject: true,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.status).toBe('done') // succeeded on the successor (no worktree → updateStatus done)
    expect(fake.startCount).toBe(2) // initial + one rotation
    expect(fake.serializeCount).toBe(1) // the codec was exercised
    // The successor's sessionKey is the rotation-suffixed one; its context carries the handoff note.
    expect(fake.startedSessionKeys[1]).toMatch(/:r1$/)
    expect(fake.startedContexts[1]).toContain('Session handoff (rotation)')

    // The session_rotated obs event was emitted under the run's trace.
    const db = createDb(getDbPath())
    const rotated = listEvents(db, { taskId, kinds: ['session_rotated'] })
    expect(rotated).toHaveLength(1)
    const data = JSON.parse(rotated[0]!.data) as {
      reason: string
      to: string
      rotationIndex: number
    }
    expect(data.reason).toBe('max_turns')
    expect(data.rotationIndex).toBe(1)

    // The sessions lineage links successor → predecessor.
    const successor = getSessionBySourceId(db, 'claude-code', data.to)
    expect(successor?.parentSessionId).toBeTruthy()
    expect(getSessionLineage(db, successor!.id)).toHaveLength(2)
  })

  it('caps the rotation chain at maxRotations and releases the task', async () => {
    const taskId = newTask()
    const fake = new RotatingAdapter('claude-code', [
      'max_turns',
      'max_turns',
      'max_turns',
      'max_turns',
    ])
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'claude-1',
      disableMemoryAutoInject: true,
      maxRotations: 2,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.doneReason).toBe('max_turns')
    expect(result.status).toBe('todo') // chain exhausted → released, retryable
    expect(fake.startCount).toBe(3) // initial + 2 rotations
    const db = createDb(getDbPath())
    expect(listEvents(db, { taskId, kinds: ['session_rotated'] })).toHaveLength(2)
  })

  it('does NOT rotate a clean success', async () => {
    const taskId = newTask()
    const fake = new RotatingAdapter('claude-code', ['success'])
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'claude-1',
      disableMemoryAutoInject: true,
    })
    expect(result.ok && result.status).toBe('done')
    expect(fake.startCount).toBe(1)
    expect(fake.serializeCount).toBe(0)
    expect(listEvents(createDb(getDbPath()), { taskId, kinds: ['session_rotated'] })).toHaveLength(
      0,
    )
  })

  it('accumulates budget spend across rotations (cumulative, not per-run)', async () => {
    const taskId = newTask()
    const db = createDb(getDbPath())
    setBudgetLimit(db, { scope: 'agent', scopeId: 'claude-1', limitUsdCents: 100 }) // high → never pauses
    const fake = new RotatingAdapter('claude-code', ['max_turns', 'success'], 0.05) // 5¢ per run
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fake,
      taskId,
      assigneeAgentId: 'claude-1',
      disableMemoryAutoInject: true,
    })
    expect(result.ok).toBe(true)
    // Two runs × 5¢ = 10¢ recorded against the agent budget.
    expect(getBudget(createDb(getDbPath()), 'agent', 'claude-1')?.spentUsdCents).toBe(10)
  })

  it('injects an <auto-memory> block at run start (and suppresses it when disabled)', async () => {
    // Seed a relevant fact into the SAME db the runner reads.
    await new SqliteMemoryStore(createDb(getDbPath())).saveFact({
      title: 'Payments',
      content: 'payment processing uses the Stripe checkout API',
      scope: { teamId: 'team-1' },
    })

    const taskOn = newTask()
    const fakeOn = new RotatingAdapter('claude-code', ['success'])
    await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fakeOn,
      taskId: taskOn,
      assigneeAgentId: 'claude-1',
    })
    expect(fakeOn.startedContexts[0]).toContain('<auto-memory')
    expect(fakeOn.startedContexts[0]).toContain('Stripe checkout')

    const taskOff = newTask()
    const fakeOff = new RotatingAdapter('claude-code', ['success'])
    await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => fakeOff,
      taskId: taskOff,
      assigneeAgentId: 'claude-1',
      disableMemoryAutoInject: true,
    })
    expect(fakeOff.startedContexts[0]).not.toContain('<auto-memory')
  })
})
