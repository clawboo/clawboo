// Routines that fall due together queue for the process's run slots instead of
// all starting at once. The ticker still fires every due routine in one pass;
// each fire's run waits its turn before it claims its task, so its card sits in
// To do, and every fire still succeeds. Real ticker, wake-bridge and task runner;
// only the adapter is scripted.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agents,
  getScheduledRun,
  listTasks,
  registerScheduledRun,
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

import { getDb, resetDb } from '../../db'
import { runTaskOnRuntime } from '../../executorRunner'
import { createRunSlots, setRunSlotsForTests } from '../../runSlots'
import { createRoutinesTicker } from '../ticker'
import { dispatchRoutine } from '../wakeBridge'

const AGENTS = ['agent-1', 'agent-2', 'agent-3']

describe('routines under the run cap', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-routines-cap-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = getDb()
    const now = Date.now()
    db.insert(agents)
      .values(
        AGENTS.map((id) => ({
          id,
          name: id,
          gatewayId: id,
          runtime: 'claude-code',
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run()
    setRunSlotsForTests(createRunSlots(1))
  })

  afterEach(async () => {
    setRunSlotsForTests(null)
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file.
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  it('runs routines that fall due together one slot at a time, and every fire succeeds', async () => {
    const live = { now: 0, max: 0 }
    /** Tasks in progress at each start: only the run that just claimed its own. */
    const inProgressAtStart: number[] = []
    const caps: Capabilities = {
      streaming: true,
      mcp: false,
      worktrees: false,
      resume: false,
      toolApproval: false,
      models: [],
    }
    const adapter: RuntimeAdapter = {
      id: 'claude-code',
      participantKind: 'agent',
      capabilities: () => caps,
      async health() {
        return { ok: true }
      },
      async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
        live.now += 1
        live.max = Math.max(live.max, live.now)
        inProgressAtStart.push(listTasks(db).filter((t) => t.status === 'in_progress').length)
        return { adapterId: 'claude-code', sessionKey: opts.sessionKey, runId: null }
      },
      events(run: RunHandle): AsyncIterable<RuntimeEvent> {
        return (async function* () {
          // Take a few turns of the event loop, so overlapping runs would show.
          for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
          live.now -= 1
          yield {
            kind: 'done',
            reason: 'success',
            summary: 'swept',
            runId: run.sessionKey,
            sessionId: run.sessionKey,
            ts: 1,
            seq: 1,
          } as RuntimeEvent
        })()
      },
      async abort() {},
      async setModel() {},
      async writeContext() {},
    }

    const routineIds = AGENTS.map((agentId) => {
      const registered = registerScheduledRun(db, {
        agentId,
        teamId: null,
        cronSpec: '* * * * *',
        taskTemplate: JSON.stringify({ title: `Sweep for ${agentId}`, kind: 'research' }),
        nextRunAt: 1_000,
      })
      if (!registered.ok) throw new Error('register failed')
      return registered.run.id
    })

    const ticker = createRoutinesTicker({
      db,
      now: () => 2_000,
      log: { info: () => {}, warn: () => {}, error: () => {} },
      dispatch: (run) =>
        dispatchRoutine(run, {
          db,
          mcpBaseUrl: null,
          runTask: (input) =>
            runTaskOnRuntime({
              ...input,
              makeAdapter: () => adapter,
              disableMemoryAutoInject: true,
            }),
        }),
    })

    const { fired } = await ticker.tick()
    expect(fired).toBe(3)

    // All three fired in one pass, but only one ran at a time.
    expect(live.max).toBe(1)
    expect(inProgressAtStart).toEqual([1, 1, 1])
    // Waiting was never a failure: every task finished and every routine re-armed.
    const tasks = listTasks(db)
    expect(tasks).toHaveLength(3)
    expect(tasks.map((t) => t.status)).toEqual(['done', 'done', 'done'])
    for (const id of routineIds) {
      const row = getScheduledRun(db, id)
      expect(row?.status).toBe('idle')
      expect(row?.lastError ?? null).toBeNull()
    }
  })
})
