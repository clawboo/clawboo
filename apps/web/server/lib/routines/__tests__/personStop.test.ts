// A PERSON moving the card of a routine's in-flight agent fire. The board PATCH
// hands the move to `noteHumanMove`, which stops the executor runner's run. That
// stop is the person's decision, not a failed fire: the task keeps the status
// they gave it (never set aside as blocked) and the routine stays armed.
//
// The whole chain is real except the runtime: the ticker claims the due routine,
// the wake bridge files the task and dispatches it through the real executor
// runner, and the runtime hangs until it is aborted.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  createDb,
  getComments,
  getScheduledRun,
  getTask,
  listEvents,
  listTasks,
  registerScheduledRun,
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
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runTaskOnRuntime } from '../../executorRunner'
import { noteHumanMove } from '../../teamChat/humanMove'
import { createRoutinesTicker } from '../ticker'
import { dispatchRoutine } from '../wakeBridge'

const CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: true,
  toolApproval: false,
  models: [],
  runtimeClass: 'native',
  nativeHome: { scope: 'per-identity', persist: true },
}

/** A runtime that streams once, then waits until it is aborted. */
function hangingAdapter() {
  const state = { aborted: false, release: null as null | (() => void) }
  const adapter: RuntimeAdapter = {
    id: 'clawboo-native',
    participantKind: 'agent',
    capabilities: () => CAPS,
    async health() {
      return { ok: true }
    },
    async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
      return { adapterId: 'clawboo-native', sessionKey: opts.sessionKey, runId: null }
    },
    events(run: RunHandle): AsyncIterable<RuntimeEvent> {
      const b = () => ({ runId: run.sessionKey, sessionId: run.sessionKey, ts: 1, seq: 1 })
      return (async function* () {
        yield { ...b(), kind: 'text-delta', text: 'working', channel: 'assistant' } as RuntimeEvent
        await new Promise<void>((res) => {
          state.release = res
        })
        yield {
          ...b(),
          kind: 'done',
          reason: state.aborted ? 'aborted' : 'success',
          summary: '',
        } as RuntimeEvent
      })()
    },
    async abort() {
      state.aborted = true
      state.release?.()
    },
    async setModel() {},
    async writeContext() {},
  }
  return { adapter, state }
}

const noopLog = { info: () => {}, warn: () => {}, error: () => {} }
const NOW = Date.parse('2026-06-10T12:00:30.000Z')

describe('a person moving a routine fire’s card while it runs', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-routine-person-stop-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    // The runner materializes the agent's persistent home under clawboo's dir.
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = createDb(path.join(home, 'test.db'))
    const now = Date.now()
    db.insert(agents)
      .values({
        id: 'agent-native',
        name: 'Ada',
        gatewayId: 'agent-native',
        sourceId: 'clawboo-native',
        sourceAgentId: 'agent-native',
        participantKind: 'agent',
        runtime: 'clawboo-native',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    // This suite owns its connection; close it before removing the directory
    // (Windows refuses to remove a directory holding an open file).
    db.$client.close()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  /** Fire a due daily routine and stop it the way the board PATCH does. */
  async function fireAndMove(to: 'todo' | 'cancelled') {
    const reg = registerScheduledRun(db, {
      agentId: 'agent-native',
      teamId: 'team-1',
      cronSpec: '0 9 * * *',
      taskTemplate: JSON.stringify({ title: 'Morning chore', kind: 'research', priority: 1 }),
      nextRunAt: 1_000,
      tenantId: null,
    })
    if (!reg.ok) throw new Error(`register failed: ${reg.reason}`)
    const { adapter, state } = hangingAdapter()
    const ticker = createRoutinesTicker({
      db,
      log: noopLog,
      now: () => NOW,
      dispatch: (run) =>
        dispatchRoutine(run, {
          db,
          mcpBaseUrl: null,
          runTask: (input) => runTaskOnRuntime({ ...input, makeAdapter: () => adapter }),
        }),
    })

    const tick = ticker.tick()
    while (!state.release) await new Promise((r) => setTimeout(r, 5))
    const [task] = listTasks(db, { teamId: 'team-1' })
    expect(task?.status).toBe('in_progress')

    // The board PATCH: the move is written, then the run working on it stopped.
    expect(updateStatus(db, task!.id, to, { actor: 'person' }).ok).toBe(true)
    noteHumanMove(db, { taskId: task!.id, teamId: 'team-1', from: 'in_progress', to })
    await tick

    expect(state.aborted).toBe(true)
    return { taskId: task!.id, routineId: reg.run.id }
  }

  it.each([
    ['todo', 'To do'],
    ['cancelled', 'Cancelled'],
  ] as const)(
    'moved to %s: the task keeps the person’s status and the routine stays armed',
    async (to, label) => {
      const { taskId, routineId } = await fireAndMove(to)

      // Never set aside as a failed fire.
      expect(getTask(db, taskId)?.status).toBe(to)
      const bodies = getComments(db, taskId).map((c) => c.body)
      expect(bodies).toEqual([`Stopped: a person moved the card to ${label}.`])
      expect(bodies.some((b) => b.includes('scheduled run failed'))).toBe(false)

      // The fire counted as done, so the routine is re-armed, not parked in error.
      const routine = getScheduledRun(db, routineId)
      expect(routine?.status).toBe('idle')
      expect(routine?.lastError).toBeNull()
      expect(routine?.nextRunAt).toBeGreaterThan(NOW)
      const kinds = listEvents(db).map((e) => e.kind)
      expect(kinds).toContain('routine_completed')
      expect(kinds).not.toContain('routine_error')
    },
  )
})
