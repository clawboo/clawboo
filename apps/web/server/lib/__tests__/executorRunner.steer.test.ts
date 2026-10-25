// `steerTaskRun`: a person commented on a task the executor runner is working on
// (a routine fire, a direct runtime run), and the comment reaches the run while it
// works. The steer is the runtime's business, so the runner's only job is to keep
// the run registered while it lives; what matters here is that a steered run is
// still ONE run to the runner: no abort, no release, one execution, one completion.
// Driven against a real sqlite board with a runtime parked mid-stream that resumes
// (inside the same run, the interrupt-and-resume shape) when it is steered.

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
  SteerResult,
  TaskHandle,
} from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDb, resetDb } from '../db'
import { runTaskOnRuntime } from '../executorRunner'
import { hasRunForTask, steerTaskRun } from '../runSteers'

// No worktree: this exercises the steer, not the workspace.
const CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: true,
  toolApproval: false,
  models: [],
  runtimeClass: 'native',
  nativeHome: { scope: 'per-identity', persist: true },
  steering: 'interrupt-resume',
}

/** A runtime that works until it is steered, then resumes and finishes. */
function steerableAdapter() {
  const state = {
    steers: [] as string[],
    aborted: false,
    parked: false,
    resume: null as null | (() => void),
  }
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
        yield { ...b(), kind: 'text-delta', text: 'drafting', channel: 'assistant' } as RuntimeEvent
        await new Promise<void>((res) => {
          state.resume = res
          state.parked = true
        })
        // The resumed run, inside the same stream: no terminal for the stopped part.
        yield { ...b(), kind: 'status', phase: 'init' } as RuntimeEvent
        yield {
          ...b(),
          kind: 'done',
          reason: state.aborted ? 'aborted' : 'success',
          summary: state.aborted ? '' : `finished with ${state.steers.length} note(s)`,
        } as RuntimeEvent
      })()
    },
    async steer(_run: RunHandle, text: string): Promise<SteerResult> {
      state.steers.push(text)
      state.resume?.()
      return { delivered: true, mode: 'interrupt-resume' }
    },
    async abort() {
      state.aborted = true
      state.resume?.()
    },
    async setModel() {},
    async writeContext() {},
  }
  return { adapter, state }
}

async function parked(state: { parked: boolean }): Promise<void> {
  while (!state.parked) await new Promise((r) => setTimeout(r, 5))
}

describe('steerTaskRun on the executor path', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-exec-steer-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  })
  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  const newTask = (title: string): string =>
    createTask(getDb(), { title, description: 'do it', status: 'todo', teamId: 'team-1' }).id

  it('reaches the run in flight; the run neither fails nor releases the task', async () => {
    const taskId = newTask('write the summary')
    const { adapter, state } = steerableAdapter()
    const p = runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'agent-steer',
    })
    await parked(state)
    expect(hasRunForTask(taskId)).toBe(true)
    expect(getTask(getDb(), taskId)?.status).toBe('in_progress')

    await expect(steerTaskRun(taskId, 'Add a one-line TL;DR.')).resolves.toEqual({
      delivered: true,
      mode: 'interrupt-resume',
    })
    const result = await p

    expect(state.steers).toEqual(['Add a one-line TL;DR.'])
    expect(state.aborted).toBe(false)
    expect(result.ok && result.doneReason).toBe('success')
    expect(listExecutions(getDb(), taskId).map((e) => e.status)).toEqual(['succeeded'])
    const task = getTask(getDb(), taskId)!
    expect(task.status).toBe('done')
    expect(task.assigneeAgentId).toBe('agent-steer')
    expect(getComments(getDb(), taskId).some((c) => c.body.includes('finished with 1 note'))).toBe(
      true,
    )
    // Released from the registry once the run ended.
    expect(hasRunForTask(taskId)).toBe(false)
    await expect(steerTaskRun(taskId, 'late')).resolves.toEqual({
      delivered: false,
      reason: 'no-run',
    })
  })

  it('steers only the named task', async () => {
    const taskId = newTask('one')
    const other = newTask('two')
    const { adapter, state } = steerableAdapter()
    const p = runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'agent-steer',
    })
    await parked(state)
    await expect(steerTaskRun(other, 'not for you')).resolves.toEqual({
      delivered: false,
      reason: 'no-run',
    })
    expect(state.steers).toEqual([])
    await adapter.abort({ adapterId: 'clawboo-native', sessionKey: '', runId: null })
    await p
  })
})
