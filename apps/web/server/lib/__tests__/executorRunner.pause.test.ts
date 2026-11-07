// A pause on the task runner: a run it covers does not start and claims nothing, one
// waiting in the queue does not start when a slot frees, and one going stops within
// seconds, back in To do, with a ledger row the fire policy reads as free to run
// again. Driven against a real sqlite board with runtimes that hang until released.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { ledgerAllowsAutoFire, PAUSED_RUN_CLASS } from '@clawboo/board-core'
import {
  createTask,
  getComments,
  getTask,
  liftPause,
  getTaskVerification,
  listExecutions,
  placePause,
  setTaskVerification,
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
import { createRunSlots, setRunSlotsForTests, type RunSlots } from '../runSlots'
import { stopPausedTaskRuns } from '../runStops'

const CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
}
const NOTE = 'Stopped: this agent is paused.'

function heldAdapter() {
  const state = { started: 0, aborted: false, finish: null as null | (() => void) }
  const adapter: RuntimeAdapter = {
    id: 'claude-code',
    participantKind: 'agent',
    capabilities: () => CAPS,
    async health() {
      return { ok: true }
    },
    async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
      state.started++
      return { adapterId: 'claude-code', sessionKey: opts.sessionKey, runId: null }
    },
    events(run: RunHandle): AsyncIterable<RuntimeEvent> {
      const b = () => ({ runId: run.sessionKey, sessionId: run.sessionKey, ts: 1, seq: 1 })
      return (async function* () {
        yield { ...b(), kind: 'text-delta', text: 'working', channel: 'assistant' } as RuntimeEvent
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
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

describe('a pause on the task runner', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let slots: RunSlots

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-runner-pause-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    resetDb()
    expect(getDbPath().startsWith(home)).toBe(true)
    slots = createRunSlots(1)
    setRunSlotsForTests(slots)
  })
  afterEach(async () => {
    setRunSlotsForTests(null)
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  const newTask = (title: string): string =>
    createTask(getDb(), { title, description: 'do it', status: 'todo', teamId: 'team-1' }).id

  const run = (taskId: string, adapter: RuntimeAdapter, agentId: string): Promise<RunTaskResult> =>
    runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: agentId,
      kind: 'research',
      disableMemoryAutoInject: true,
    })

  it('refuses a run it covers, claiming nothing and taking no slot', async () => {
    const { adapter, state } = heldAdapter()
    for (const [kind, id] of [
      ['agent', 'a1'],
      ['team', 'team-1'],
    ] as const) {
      const task = newTask(`covered by ${kind}`)
      placePause(getDb(), { kind, id })
      expect(await run(task, adapter, 'a1')).toEqual({ ok: false, reason: 'paused' })
      expect(getTask(getDb(), task)!.status).toBe('todo')
      liftPause(getDb(), kind, id)
    }
    expect(state.started).toBe(0)
    expect(slots.stats()).toMatchObject({ running: 0, queued: 0 })
  })

  it('does not start a run waiting in the queue when a slot frees, and starts it on resume', async () => {
    const first = heldAdapter()
    const second = heldAdapter()
    const going = run(newTask('first'), first.adapter, 'a1')
    await until(() => first.state.finish !== null)
    const waitingTask = newTask('second')
    const waiting = run(waitingTask, second.adapter, 'a2')
    await until(() => slots.stats().queued === 1)
    // Placed after it joined the queue, with no stop: the queue's own read of it.
    placePause(getDb(), { kind: 'agent', id: 'a2' })

    first.state.finish!()
    await going
    await settle()
    expect(second.state.started).toBe(0)
    expect(getTask(getDb(), waitingTask)!.status).toBe('todo')
    expect(slots.stats()).toMatchObject({ running: 0, queued: 1 })

    liftPause(getDb(), 'agent', 'a2')
    slots.resume()
    await until(() => second.state.finish !== null)
    second.state.finish!()
    expect((await waiting).ok).toBe(true)
  })

  it('keeps what the task’s check found: its fix rounds do not start over on resume', async () => {
    const { adapter, state } = heldAdapter()
    const task = newTask('running')
    const going = run(task, adapter, 'a1')
    await until(() => state.finish !== null)
    setTaskVerification(getDb(), task, {
      status: 'fail',
      attempts: [
        {
          attempt: 1,
          at: Date.now(),
          deterministic: {
            command: 'test',
            exitCode: 1,
            passed: false,
            stdoutTail: '',
            stderrTail: 'it failed',
            durationMs: 1,
            timedOut: false,
          },
          critic: {
            ran: false,
            findings: [],
            reviewerRuntime: null,
            reviewerModel: null,
            reviewedSha: null,
          },
          status: 'fail',
          structuredError: null,
        },
      ],
      debtNotes: [],
      updatedAt: Date.now(),
    })
    placePause(getDb(), { kind: 'agent', id: 'a1' })

    expect(stopPausedTaskRuns(({ agentId }) => agentId === 'a1', NOTE)).toEqual([task])
    await going

    expect(getTask(getDb(), task)!.status).toBe('todo')
    expect(getTaskVerification(getDb(), task)?.attempts).toHaveLength(1)
  })

  it('stops a run going, back in To do, with a ledger row that fires again on resume', async () => {
    const { adapter, state } = heldAdapter()
    const task = newTask('running')
    const going = run(task, adapter, 'a1')
    await until(() => state.finish !== null)
    placePause(getDb(), { kind: 'agent', id: 'a1' })

    const stopped = stopPausedTaskRuns(({ agentId }) => agentId === 'a1', NOTE)
    expect(stopped).toEqual([task])
    const result = await going

    expect(result).toMatchObject({
      ok: true,
      doneReason: 'aborted',
      stoppedByPerson: true,
      stoppedByPause: true,
    })
    expect(getTask(getDb(), task)!.status).toBe('todo')
    const execs = listExecutions(getDb(), task)
    expect(execs.at(-1)).toMatchObject({
      status: 'cancelled',
      errorClass: PAUSED_RUN_CLASS,
      error: NOTE,
    })
    expect(ledgerAllowsAutoFire(execs)).toBe(true)
    expect(getComments(getDb(), task).map((c) => c.body)).toContain(NOTE)
  })

  it('leaves a run still waiting for a slot in the queue, to start on resume', async () => {
    const first = heldAdapter()
    const second = heldAdapter()
    const going = run(newTask('first'), first.adapter, 'a1')
    await until(() => first.state.finish !== null)
    const waitingTask = newTask('second')
    const waiting = run(waitingTask, second.adapter, 'a2')
    await until(() => slots.stats().queued === 1)

    placePause(getDb(), { kind: 'agent', id: 'a2' })
    // Stopping it now would leave a To do card nothing is coming for, since it has
    // claimed nothing and saved nothing to run again from.
    expect(stopPausedTaskRuns(({ agentId }) => agentId === 'a2', NOTE)).toEqual([])
    first.state.finish!()
    await going
    await settle()
    expect(second.state.started).toBe(0)

    liftPause(getDb(), 'agent', 'a2')
    slots.resume()
    await until(() => second.state.finish !== null)
    second.state.finish!()
    expect((await waiting).ok).toBe(true)
  })

  it('leaves a run the pause does not cover alone', async () => {
    const { adapter, state } = heldAdapter()
    const going = run(newTask('someone else'), adapter, 'a2')
    await until(() => state.finish !== null)
    expect(stopPausedTaskRuns(({ agentId }) => agentId === 'a1', NOTE)).toEqual([])
    expect(state.aborted).toBe(false)
    state.finish!()
    expect(await going).toMatchObject({ ok: true, doneReason: 'success' })
  })
})
