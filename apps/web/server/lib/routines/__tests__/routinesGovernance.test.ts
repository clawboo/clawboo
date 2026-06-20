// END-TO-END: governance applies to scheduled work because a Routine fire IS a
// standard executor dispatch. Register a routine → manual tick → the REAL
// wake-bridge → the REAL runTaskOnRuntime (with a cost-emitting fake adapter)
// → the budget kill-switch auto-pauses, the board task is released to todo,
// and the routine parks in error — nothing bypassed.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agents,
  createDb,
  getBudget,
  getScheduledRun,
  listEvents,
  listTasks,
  registerScheduledRun,
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

import { getDbPath } from '../../db'
import { runTaskOnRuntime } from '../../executorRunner'
import { createRoutinesTicker } from '../ticker'
import { dispatchRoutine } from '../wakeBridge'

/** A fake runtime whose first cost event blows through the agent budget cap. */
class CostlyFakeAdapter implements RuntimeAdapter {
  readonly id = 'claude-code'
  readonly participantKind = 'agent' as const
  capabilities(): Capabilities {
    return {
      streaming: true,
      mcp: true,
      worktrees: true,
      resume: true,
      toolApproval: true,
      models: [],
    }
  }
  async health() {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    let seq = 0
    const base = () => ({
      runId: run.sessionKey,
      sessionId: run.sessionKey,
      ts: 1,
      seq: (seq += 1),
    })
    return (async function* () {
      yield {
        ...base(),
        kind: 'cost',
        costUsd: 0.5, // 50¢ against a 40¢ cap → immediate auto-pause
        usage: { inputTokens: 100, outputTokens: 100 },
        model: 'fake',
      } as RuntimeEvent
      yield {
        ...base(),
        kind: 'done',
        reason: 'success',
        summary: 'should never be reached cleanly',
      } as RuntimeEvent
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

describe('routines × governance (real ledger + real executor runner)', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-routines-gov-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = createDb(getDbPath())
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'agent-cc',
        name: 'CC',
        gatewayId: 'agent-cc',
        runtime: 'claude-code',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('a scheduled fire that exceeds budget hits the SAME kill-switch as a chat-driven run', async () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'agent-cc', limitUsdCents: 40, mode: 'cap' })

    const registered = registerScheduledRun(db, {
      agentId: 'agent-cc',
      teamId: 'team-1',
      // 'research' isolation = no worktree, so the fire needs no git repo —
      // the budget loop is the subject here.
      cronSpec: '* * * * *',
      taskTemplate: JSON.stringify({ title: 'Expensive sweep', kind: 'research', priority: 0 }),
      nextRunAt: 1_000,
    })
    if (!registered.ok) throw new Error('register failed')

    const fake = new CostlyFakeAdapter()
    const ticker = createRoutinesTicker({
      db,
      now: () => 2_000,
      log: { info: () => {}, error: () => {} },
      // The REAL wake-bridge + the REAL runner; only the adapter is scripted.
      dispatch: (run) =>
        dispatchRoutine(run, {
          db,
          mcpBaseUrl: null,
          runTask: (input) =>
            runTaskOnRuntime({ ...input, makeAdapter: () => fake, disableMemoryAutoInject: true }),
        }),
    })

    const { fired } = await ticker.tick()
    expect(fired).toBe(1)

    // The budget auto-paused...
    expect(getBudget(db, 'agent', 'agent-cc')?.status).toBe('paused')
    // ...the materialized board task was released to todo (retryable)...
    const tasks = listTasks(db)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]).toMatchObject({
      title: 'Expensive sweep',
      status: 'todo',
      scheduledBy: 'clawboo',
    })
    // ...and the routine parked in error (disarmed) with the budget reason.
    const run = getScheduledRun(db, registered.run.id)
    expect(run?.status).toBe('error')
    expect(run?.lastError).toContain('auto-paused')
    expect(run?.nextRunAt).toBeNull()

    // The obs trail shows the full routine lifecycle.
    const kinds = listEvents(db).map((e) => e.kind)
    expect(kinds).toContain('routine_fired')
    expect(kinds).toContain('routine_dispatched')
    expect(kinds).toContain('routine_error')
  })
})
