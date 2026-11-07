// The process-wide run cap on the task runner: with every slot taken, the next
// run waits its turn BEFORE it claims its task, so the card stays in To do and
// nothing reads as failed; it runs as soon as a slot frees; and the caller leaving
// or a person moving the card takes it out of the queue without it ever starting.
// Driven against a real sqlite board with runtimes that hang until released.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createTask, getComments, getTask, listExecutions } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../db'
import { seedSandboxTeam } from './seedTeam'
import { runTaskOnRuntime, type RunTaskResult } from '../executorRunner'
import { createRunSlots, setRunSlotsForTests, type RunSlots } from '../runSlots'
import { stopTaskRuns } from '../runStops'

// No worktree and an ephemeral home: this exercises the cap, not the workspace or
// the per-agent lock.
const CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
}

/** A runtime that streams once, then holds until it is finished or aborted. */
function heldAdapter() {
  const state = {
    started: 0,
    aborted: false,
    /** Set once the run is parked mid-stream. */
    finish: null as null | (() => void),
  }
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

/** Wait until `cond` holds (polling, not a fixed sleep). */
async function until(cond: () => boolean): Promise<void> {
  while (!cond()) await new Promise((r) => setTimeout(r, 5))
}

/** Let pending callbacks run, so a run that WOULD start has had every chance to. */
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r))
}

describe('the run cap on the task runner', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let slots: RunSlots

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-run-cap-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    seedSandboxTeam(home)
    slots = createRunSlots(1)
    setRunSlotsForTests(slots)
  })
  afterEach(async () => {
    setRunSlotsForTests(null)
    // Close BEFORE removing the dir: Windows refuses to remove a directory that
    // still holds an open file.
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  const newTask = (title: string): string =>
    createTask(getDb(), { title, description: 'do it', status: 'todo', teamId: 'team-1' }).id

  const run = (
    taskId: string,
    adapter: RuntimeAdapter,
    agentId: string,
    abortSignal?: AbortSignal,
  ): Promise<RunTaskResult> =>
    runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: agentId,
      kind: 'research',
      disableMemoryAutoInject: true,
      ...(abortSignal ? { abortSignal } : {}),
    })

  it('makes run N+1 wait, unclaimed, until a slot frees, then runs it', async () => {
    const first = heldAdapter()
    const second = heldAdapter()
    const taskA = newTask('first')
    const taskB = newTask('second')

    const pA = run(taskA, first.adapter, 'agent-a')
    await until(() => first.state.finish !== null)
    const pB = run(taskB, second.adapter, 'agent-b')
    await settle()

    // B waits for the one slot: never started, never claimed, nothing failed.
    expect(second.state.started).toBe(0)
    expect(slots.stats()).toEqual({ size: 1, running: 1, queued: 1 })
    expect(getTask(getDb(), taskB)?.status).toBe('todo')
    expect(listExecutions(getDb(), taskB)).toEqual([])
    expect(getComments(getDb(), taskB)).toEqual([])

    // A finishes and gives the slot back; B takes it and runs.
    first.state.finish!()
    const resultA = await pA
    expect(resultA.ok && resultA.doneReason).toBe('success')
    await until(() => second.state.finish !== null)
    expect(second.state.started).toBe(1)
    expect(getTask(getDb(), taskB)?.status).toBe('in_progress')

    second.state.finish!()
    const resultB = await pB
    expect(resultB.ok && resultB.doneReason).toBe('success')
    expect(getTask(getDb(), taskB)?.status).toBe('done')
    expect(slots.stats()).toEqual({ size: 1, running: 0, queued: 0 })
  })

  it('takes a queued run out of the queue when its caller leaves; it never starts', async () => {
    const first = heldAdapter()
    const second = heldAdapter()
    const taskA = newTask('holding the slot')
    const taskB = newTask('queued, then abandoned')

    const pA = run(taskA, first.adapter, 'agent-a')
    await until(() => first.state.finish !== null)
    const caller = new AbortController()
    const pB = run(taskB, second.adapter, 'agent-b', caller.signal)
    await settle()
    expect(slots.stats().queued).toBe(1)

    caller.abort()
    const resultB = await pB
    // The same answer as a caller that left while waiting on the agent's lock.
    expect(resultB).toEqual({ ok: false, reason: 'conflict' })
    expect(second.state.started).toBe(0)
    expect(getTask(getDb(), taskB)?.status).toBe('todo')
    expect(listExecutions(getDb(), taskB)).toEqual([])
    expect(slots.stats()).toEqual({ size: 1, running: 1, queued: 0 })

    // The run holding the slot is untouched.
    expect(first.state.aborted).toBe(false)
    first.state.finish!()
    expect((await pA).ok).toBe(true)
    expect(slots.stats().running).toBe(0)
  })

  it('a person moving the card of a queued run ends the wait without a start', async () => {
    const first = heldAdapter()
    const second = heldAdapter()
    const taskA = newTask('holding the slot')
    const taskB = newTask('moved while queued')

    const pA = run(taskA, first.adapter, 'agent-a')
    await until(() => first.state.finish !== null)
    const pB = run(taskB, second.adapter, 'agent-b')
    await settle()

    expect(stopTaskRuns(taskB, 'Stopped: a person moved the card to Done.')).toBe(true)
    expect(await pB).toEqual({ ok: false, reason: 'conflict' })
    expect(second.state.started).toBe(0)
    expect(listExecutions(getDb(), taskB)).toEqual([])
    expect(slots.stats().queued).toBe(0)

    first.state.finish!()
    await pA
  })

  it('a run that throws gives its slot back, so the next one is not stranded', async () => {
    const taskA = newTask('throws')
    const taskB = newTask('next')
    const boom: RuntimeAdapter = {
      ...heldAdapter().adapter,
      async start(): Promise<RunHandle> {
        throw new Error('spawn failed')
      },
    }
    const next = heldAdapter()

    await expect(run(taskA, boom, 'agent-a')).rejects.toThrow('spawn failed')
    expect(slots.stats().running).toBe(0)

    const pB = run(taskB, next.adapter, 'agent-b')
    await until(() => next.state.finish !== null)
    next.state.finish!()
    expect((await pB).ok).toBe(true)
    expect(slots.stats().running).toBe(0)
  })
})
