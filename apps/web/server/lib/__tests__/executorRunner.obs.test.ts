// Observability wiring in the executor runner. A fake adapter yields a scripted
// normalized stream (text/tool-call/tool-result/cost/done); we assert the runner
// emits the full span_start → execution_started → tool_call/tool_result → cost →
// execution_completed → span_end sequence under ONE traceId (AC1) and that a
// terminal done{reason:'error'} with an unmappable message produces an `error`
// event flagged harnessBug (AC5). No git/worktrees needed — the fake adapter
// declares `worktrees: false`, so the run completes without a worktree.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { createDb, createTask, listEvents } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { getDbPath } from '../db'
import { runTaskOnRuntime } from '../executorRunner'
import { spanIdFor } from '../obs'

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
}

class ScriptedAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  constructor(
    readonly id: string,
    private readonly script: (
      base: () => { runId: string; sessionId: string | null; ts: number; seq: number },
    ) => RuntimeEvent[],
  ) {}
  capabilities(): Capabilities {
    return CAPS
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
    const evs = this.script(base)
    return (async function* () {
      for (const e of evs) yield e
    })()
  }
  async abort() {}
  async setModel() {}
  async writeContext() {}
}

describe('executor runner → observability', () => {
  let home: string
  let prevHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-exec-obs-'))
    await mkdir(path.join(home, '.openclaw', 'clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
  })
  afterEach(async () => {
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  function newTask(): string {
    return createTask(createDb(getDbPath()), { title: 'do it', status: 'todo', teamId: 'team-1' })
      .id
  }

  it('emits the full task trace under one traceId (AC1)', async () => {
    const taskId = newTask()
    const adapter = new ScriptedAdapter('claude-code', (base) => [
      { ...base(), kind: 'text-delta', text: 'working', channel: 'assistant' },
      {
        ...base(),
        kind: 'tool-call',
        toolCallId: 'tc1',
        name: 'edit_file',
        input: { path: 'a.ts' },
        partial: false,
      },
      {
        ...base(),
        kind: 'tool-result',
        toolCallId: 'tc1',
        name: 'edit_file',
        output: 'ok',
        isError: false,
      },
      {
        ...base(),
        kind: 'cost',
        costUsd: 0.05,
        usage: { inputTokens: 100, outputTokens: 50 },
        model: 'm',
      },
      { ...base(), kind: 'done', reason: 'success', summary: 'all done' },
    ])
    const result = await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'a1',
    })
    expect(result.ok).toBe(true)

    const evs = listEvents(createDb(getDbPath()), { taskId, limit: 1000 })
    const traceEvs = listEvents(createDb(getDbPath()), { limit: 1000 }).filter(
      (e) => e.kind === 'span_start',
    )
    expect(traceEvs).toHaveLength(1)
    const traceId = traceEvs[0]!.traceId
    expect(traceId).toBeTruthy()
    // All run events share the one trace.
    const all = listEvents(createDb(getDbPath()), { traceId: traceId!, limit: 1000 })
    const kinds = all.map((e) => e.kind)
    for (const k of [
      'span_start',
      'execution_started',
      'tool_call',
      'tool_result',
      'cost',
      'execution_completed',
      'span_end',
    ]) {
      expect(kinds).toContain(k)
    }
    // span_start brackets the run; span_end is last.
    expect(kinds[0]).toBe('span_start')
    expect(kinds[kinds.length - 1]).toBe('span_end')
    // Tasks events are reachable by taskId too.
    expect(evs.map((e) => e.kind)).toContain('tool_result')
  })

  it('nests a child run under its parent run via the board ancestor chain (cross-run traceparent)', async () => {
    const db = createDb(getDbPath())
    const parent = createTask(db, { title: 'parent', status: 'todo', teamId: 'team-1' })
    const child = createTask(db, {
      title: 'child',
      status: 'todo',
      teamId: 'team-1',
      parentTaskId: parent.id,
    })

    const done = (
      base: () => { runId: string; sessionId: string | null; ts: number; seq: number },
    ): RuntimeEvent[] => [{ ...base(), kind: 'done', reason: 'success', summary: 'ok' }]
    await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => new ScriptedAdapter('cc', done),
      taskId: parent.id,
      assigneeAgentId: 'a1',
    })
    await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => new ScriptedAdapter('cc', done),
      taskId: child.id,
      assigneeAgentId: 'a2',
    })

    const starts = listEvents(createDb(getDbPath()), { kinds: ['span_start'], limit: 100 })
    const parentStart = starts.find((e) => e.taskId === parent.id)!
    const childStart = starts.find((e) => e.taskId === child.id)!
    // One trace for the whole mission.
    expect(parentStart.traceId).toBe(childStart.traceId)
    // The child run nests under the parent run's span (both derived from task ids).
    expect(parentStart.spanId).toBe(spanIdFor(parent.id))
    expect(childStart.parentSpanId).toBe(spanIdFor(parent.id))
    expect(childStart.parentSpanId).toBe(parentStart.spanId)
    // The parent run sits under the synthetic mission root, not under itself.
    expect(parentStart.parentSpanId).not.toBe(parentStart.spanId)
  })

  it('an unmappable terminal error → error event flagged harnessBug (AC5)', async () => {
    const taskId = newTask()
    const adapter = new ScriptedAdapter('codex', (base) => [
      {
        ...base(),
        kind: 'done',
        reason: 'error',
        summary: 'the flux capacitor desynchronized at warp nine',
      },
    ])
    await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'a1',
    })

    const errors = listEvents(createDb(getDbPath()), { kinds: ['error'], limit: 100 })
    expect(errors.length).toBeGreaterThanOrEqual(1)
    const data = JSON.parse(errors[0]!.data) as { errorClass: string; harnessBug: boolean }
    expect(data.errorClass).toBe('Unknown')
    expect(data.harnessBug).toBe(true)
  })

  it('a recognized terminal error → classified, NOT a harness bug', async () => {
    const taskId = newTask()
    const adapter = new ScriptedAdapter('codex', (base) => [
      { ...base(), kind: 'done', reason: 'error', summary: 'request timed out after 600s' },
    ])
    await runTaskOnRuntime({
      db: createDb(getDbPath()),
      makeAdapter: () => adapter,
      taskId,
      assigneeAgentId: 'a1',
    })
    const data = JSON.parse(listEvents(createDb(getDbPath()), { kinds: ['error'] })[0]!.data) as {
      errorClass: string
      harnessBug: boolean
    }
    expect(data.errorClass).toBe('Timeout')
    expect(data.harnessBug).toBe(false)
  })
})
