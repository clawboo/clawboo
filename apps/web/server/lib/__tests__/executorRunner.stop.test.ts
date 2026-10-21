// `stopTaskRuns`: a PERSON moved the card of a task the executor runner is
// working on (a routine fire, a direct runtime run), so the run is stopped. It
// resolves exactly like a disconnected caller (aborted, execution cancelled),
// with one difference: the task's comment is the person's stop note, not the
// generic "Run aborted". Driven against a real sqlite board with a runtime that
// hangs until it is aborted, as the external-abort test in executorRunner.test.ts.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createTask, getComments, getTask, listExecutions, updateStatus } from '@clawboo/db'
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
import { runTaskOnRuntime } from '../executorRunner'
import { stopTaskRuns } from '../runStops'

// No worktree: this exercises the stop, not the workspace.
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

/** A runtime that streams once, then waits until it is aborted (or released). */
function hangingAdapter() {
  const state = {
    aborted: false,
    /** Set once the run is parked mid-stream. */
    release: null as null | (() => void),
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
        yield { ...b(), kind: 'text-delta', text: 'working', channel: 'assistant' } as RuntimeEvent
        await new Promise<void>((res) => {
          state.release = res
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
      state.release?.()
    },
    async setModel() {},
    async writeContext() {},
  }
  return { adapter, state }
}

/** Wait until the run is parked mid-stream (polling, not a fixed sleep). */
async function parked(state: { release: null | (() => void) }): Promise<void> {
  while (!state.release) await new Promise((r) => setTimeout(r, 5))
}

const NOTE = 'Stopped: a person moved the card to Done.'

describe('stopTaskRuns', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-exec-stop-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
  })
  afterEach(async () => {
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

  it('aborts the run in flight and records the stop note in place of "Run aborted"', async () => {
    const taskId = newTask('stop me')
    const { adapter, state } = hangingAdapter()
    const p = runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'agent-stop',
    })
    await parked(state)

    expect(stopTaskRuns(taskId, NOTE)).toBe(true)
    const result = await p

    expect(state.aborted).toBe(true)
    expect(result.ok && result.doneReason).toBe('aborted')
    // Marked as a person's stop, so a routine fire does not read it as a failure.
    expect(result.ok && result.stoppedByPerson).toBe(true)
    // Nothing had moved the card, so the stop released it.
    expect(result.ok && result.status).toBe('todo')
    const system = getComments(getDb(), taskId).filter((c) => c.authorType === 'system')
    expect(system.map((c) => c.body)).toEqual([NOTE])
    expect(listExecutions(getDb(), taskId).map((e) => e.status)).toEqual(['cancelled'])
    // The run is gone from the registry once it has ended.
    expect(stopTaskRuns(taskId, NOTE)).toBe(false)
  })

  it('leaves the move the person already made in place', async () => {
    const taskId = newTask('marked done mid-run')
    const { adapter, state } = hangingAdapter()
    const p = runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'agent-done',
    })
    await parked(state)

    // The board PATCH: the move is written first, then the run is stopped.
    expect(updateStatus(getDb(), taskId, 'done', { actor: 'person' }).ok).toBe(true)
    stopTaskRuns(taskId, NOTE)
    const result = await p

    expect(getTask(getDb(), taskId)?.status).toBe('done')
    // The result reports where the card really is, not the release it skipped.
    expect(result.ok && result.status).toBe('done')
    expect(result.ok && result.stoppedByPerson).toBe(true)
    expect(getComments(getDb(), taskId).map((c) => c.body)).toEqual([NOTE])
  })

  it('is false for a task no run here is working on, and stops only the named task', async () => {
    expect(stopTaskRuns('no-such-task', NOTE)).toBe(false)

    const stopped = newTask('stopped')
    const other = newTask('left alone')
    const a = hangingAdapter()
    const b = hangingAdapter()
    const pa = runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => a.adapter,
      taskId: stopped,
      assigneeAgentId: 'agent-a',
    })
    const pb = runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => b.adapter,
      taskId: other,
      assigneeAgentId: 'agent-b',
    })
    await parked(a.state)
    await parked(b.state)

    stopTaskRuns(stopped, NOTE)
    expect(b.state.aborted).toBe(false)
    // Let the other run finish on its own.
    b.state.release!()
    const [ra, rb] = await Promise.all([pa, pb])
    expect(ra.ok && ra.doneReason).toBe('aborted')
    expect(rb.ok && rb.doneReason).toBe('success')
    expect(rb.ok && rb.stoppedByPerson).toBeUndefined()
    expect(getComments(getDb(), other).some((c) => c.body === NOTE)).toBe(false)
  })

  it('a caller abort with no stop note still says "Run aborted"', async () => {
    // The note is the person's; a disconnected caller keeps the generic comment.
    const taskId = newTask('caller went away')
    const { adapter, state } = hangingAdapter()
    const ctl = new AbortController()
    const p = runTaskOnRuntime({
      db: getDb(),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'agent-caller',
      abortSignal: ctl.signal,
    })
    await parked(state)
    ctl.abort()
    const result = await p
    // Not a person's stop: a routine still treats it as a failed fire.
    expect(result.ok && result.stoppedByPerson).toBeUndefined()
    const bodies = getComments(getDb(), taskId).map((c) => c.body)
    expect(bodies).toHaveLength(1)
    expect(bodies[0]).toMatch(/^Run aborted/)
  })
})
