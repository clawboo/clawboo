// The thin connected-substrate dispatcher against a fake operator client:
// chat.send {deliver:false} on the stable per-routine session, terminal frames
// → exec succeeded + task done + subscription released, a non-success terminal
// releases the task, the watchdog aborts + releases, and the budget
// kill-switch (cost events crossing a cap budget) aborts mid-run exactly like
// any executor run.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { EventFrame } from '@clawboo/gateway-client'
import type { RuntimeEvent } from '@clawboo/executor'
import {
  agents,
  createDb,
  createTask,
  getComments,
  getTask,
  listExecutions,
  listGovernanceAudit,
  recordSpend,
  registerScheduledRun,
  setBudgetLimit,
  setTaskVerification,
  getBudget,
  type ClawbooDb,
  type DbAgent,
  type DbScheduledRun,
} from '@clawboo/db'
import { createAsyncQueue } from '@clawboo/executor'
import type { TaskTemplate } from '@clawboo/scheduler'

import { dispatchConnectedSubstrate, type OperatorClientLike } from '../openclawDispatch'

// ── Local clone of the adapter package's unpublished FakeGatewayClient ──────
class FakeOperatorClient {
  readonly calls: Array<{ method: string; params?: unknown }> = []
  private readonly handlers = new Set<(frame: EventFrame) => void>()

  onEvent(handler: (frame: EventFrame) => void): () => void {
    this.handlers.add(handler)
    return () => this.handlers.delete(handler)
  }
  emit(frame: EventFrame): void {
    for (const handler of [...this.handlers]) handler(frame)
  }
  subscriberCount(): number {
    return this.handlers.size
  }
  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    this.calls.push({ method, params })
    return undefined as T
  }
  readonly agents = {
    list: async () => ({ defaultId: 'a1', mainKey: 'agent:a1:main', agents: [] }),
    files: { set: async () => {} },
  }
  readonly sessions = {
    patch: async (key: string) => ({ ok: true, key }),
    abort: async (key: string, runId?: string) => {
      this.calls.push({ method: 'sessions.abort', params: { key, runId } })
      return { ok: true, abortedRunId: runId ?? null }
    },
  }
  readonly chat = {
    abort: async (sessionKey: string, runId: string) => {
      this.calls.push({ method: 'chat.abort', params: { sessionKey, runId } })
      return { ok: true, abortedRunId: runId }
    },
  }
}

let dir: string
let db: ClawbooDb

const TEMPLATE: TaskTemplate = {
  title: 'Morning team sweep',
  description: 'sweep',
  kind: 'research',
  priority: 0,
}

function seedAgent(id = 'oc-agent'): DbAgent {
  const now = Date.now()
  const row = {
    id,
    name: id,
    gatewayId: `gw-${id}`,
    sourceId: 'openclaw',
    sourceAgentId: `gw-${id}`,
    participantKind: 'agent',
    runtime: 'openclaw',
    createdAt: now,
    updatedAt: now,
  }
  db.insert(agents).values(row).run()
  return row as unknown as DbAgent
}

function seedRoutine(agentId: string): DbScheduledRun {
  const result = registerScheduledRun(db, {
    agentId,
    teamId: 'team-1',
    cronSpec: '0 9 * * *',
    taskTemplate: JSON.stringify(TEMPLATE),
    nextRunAt: 1_000,
  })
  if (!result.ok) throw new Error('register failed')
  return result.run
}

function seedTask(): string {
  return createTask(db, {
    title: TEMPLATE.title,
    status: 'todo',
    teamId: 'team-1',
    scheduledBy: 'clawboo',
  }).id
}

const chatFrame = (
  sessionKey: string,
  state: string,
  extra: Record<string, unknown> = {},
): EventFrame => ({
  type: 'event',
  event: 'chat',
  payload: { runId: 'run-1', sessionKey, state, ...extra },
})

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-ocdispatch-'))
  db = createDb(path.join(dir, 'test.db'))
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('dispatchConnectedSubstrate', () => {
  it('delivers via chat.send {deliver:false} on the stable per-routine session, drains to done, completes the board', async () => {
    const agentRow = seedAgent()
    const run = seedRoutine(agentRow.id)
    const taskId = seedTask()
    const client = new FakeOperatorClient()

    const dispatchPromise = dispatchConnectedSubstrate({
      db,
      run,
      template: TEMPLATE,
      agentRow,
      taskId,
      client: client as unknown as OperatorClientLike,
    })

    // The adapter's chat.send lands synchronously after start; give the
    // microtask queue a beat, then emit the terminal frame.
    await new Promise((resolve) => setImmediate(resolve))
    const sent = client.calls.find((c) => c.method === 'chat.send')
    expect(sent).toBeDefined()
    const params = sent!.params as Record<string, unknown>
    const sessionKey = `agent:gw-${agentRow.id}:clawboo-routine-${run.id}`
    expect(params['sessionKey']).toBe(sessionKey)
    expect(params['deliver']).toBe(false)
    expect(String(params['message'])).toContain('Morning team sweep')

    client.emit(
      chatFrame(sessionKey, 'final', {
        message: { role: 'assistant', content: 'swept the queue' },
      }),
    )
    const outcome = await dispatchPromise

    expect(outcome).toMatchObject({ ok: true, taskId })
    expect(getTask(db, taskId)?.status).toBe('done')
    const execs = listExecutions(db, taskId)
    expect(execs[0]).toMatchObject({
      status: 'succeeded',
      executorType: 'openclaw',
      runReason: 'routine',
    })
    expect(getComments(db, taskId).some((c) => c.body.includes('swept the queue'))).toBe(true)
    // The event subscription was released.
    expect(client.subscriberCount()).toBe(0)
  })

  it('a non-success terminal fails the exec and releases the task to todo', async () => {
    const agentRow = seedAgent()
    const run = seedRoutine(agentRow.id)
    const taskId = seedTask()
    const client = new FakeOperatorClient()
    const sessionKey = `agent:gw-${agentRow.id}:clawboo-routine-${run.id}`

    const dispatchPromise = dispatchConnectedSubstrate({
      db,
      run,
      template: TEMPLATE,
      agentRow,
      taskId,
      client: client as unknown as OperatorClientLike,
    })
    await new Promise((resolve) => setImmediate(resolve))
    client.emit(chatFrame(sessionKey, 'error', { errorMessage: 'agent blew up' }))
    const outcome = await dispatchPromise

    expect(outcome.ok).toBe(false)
    expect(getTask(db, taskId)?.status).toBe('todo') // released, retryable
    expect(listExecutions(db, taskId)[0]?.status).toBe('failed')
  })

  it('the WATCHDOG aborts a silent run: exec timed_out, task released, session aborted', async () => {
    const agentRow = seedAgent()
    const run = seedRoutine(agentRow.id)
    const taskId = seedTask()
    const client = new FakeOperatorClient()

    const outcome = await dispatchConnectedSubstrate({
      db,
      run,
      template: TEMPLATE,
      agentRow,
      taskId,
      client: client as unknown as OperatorClientLike,
      watchdogMs: 25,
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('watchdog')
    expect(getTask(db, taskId)?.status).toBe('todo')
    expect(listExecutions(db, taskId)[0]?.status).toBe('timed_out')
    // The two-tier abort fired (sessions.abort backstop at minimum).
    expect(client.calls.some((c) => c.method === 'sessions.abort')).toBe(true)
    expect(client.subscriberCount()).toBe(0)
  })

  it('the BUDGET KILL-SWITCH applies to a scheduled OpenClaw fire (cost events crossing a cap)', async () => {
    const agentRow = seedAgent()
    const run = seedRoutine(agentRow.id)
    const taskId = seedTask()
    const client = new FakeOperatorClient()
    setBudgetLimit(db, { scope: 'agent', scopeId: agentRow.id, limitUsdCents: 100, mode: 'cap' })

    let aborted = 0
    // The live Gateway emits no usage today, so the budget branch is driven by
    // an injected adapter that yields cost events — the seam exists for exactly
    // this composition.
    const queue = createAsyncQueue<RuntimeEvent>({ max: 100 })
    const outcome = await dispatchConnectedSubstrate({
      db,
      run,
      template: TEMPLATE,
      agentRow,
      taskId,
      client: client as unknown as OperatorClientLike,
      makeAdapter: () => ({
        start: async () => {
          queue.push({
            kind: 'cost',
            runId: 'run-1',
            sessionId: 'sk',
            ts: 1,
            seq: 1,
            costUsd: 2.5, // 250 cents — blows through the 100-cent cap
            usage: { inputTokens: 10, outputTokens: 10 },
            model: 'gw-model',
          } as RuntimeEvent)
          return { adapterId: 'openclaw', sessionKey: 'sk', runId: 'run-1' }
        },
        events: () => queue,
        abort: async () => {
          aborted += 1
        },
      }),
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('budget')
    expect(aborted).toBe(1)
    expect(getTask(db, taskId)?.status).toBe('todo') // released
    expect(listExecutions(db, taskId)[0]).toMatchObject({ status: 'cancelled' })
    expect(getBudget(db, 'agent', agentRow.id)?.status).toBe('paused')
  })

  it('records ESTIMATED spend on a REAL OpenClaw frame (no injected cost) and the cap engages', async () => {
    // The real-path proof: drive the REAL OpenClawAdapter (no makeAdapter override)
    // over a real `chat` final frame. The adapter emits a `done` with NO costUsd —
    // so the dispatcher must ESTIMATE spend from the produced text. A prior version
    // recorded spend ONLY against an injected fake `done.costUsd`, leaving real runs
    // invisible to budgets.
    const agentRow = seedAgent()
    const run = seedRoutine(agentRow.id)
    const taskId = seedTask()
    const client = new FakeOperatorClient()
    const sessionKey = `agent:gw-${agentRow.id}:clawboo-routine-${run.id}`
    // A tiny 1-cent cap so even a small estimate trips it.
    setBudgetLimit(db, { scope: 'agent', scopeId: agentRow.id, limitUsdCents: 1, mode: 'cap' })

    const dispatchPromise = dispatchConnectedSubstrate({
      db,
      run,
      template: TEMPLATE,
      agentRow,
      taskId,
      client: client as unknown as OperatorClientLike,
    })
    await new Promise((resolve) => setImmediate(resolve))
    const longText = 'x'.repeat(8000) // ~2000 output tokens → a non-trivial estimate
    client.emit(
      chatFrame(sessionKey, 'final', { message: { role: 'assistant', content: longText } }),
    )
    const outcome = await dispatchPromise

    expect(outcome.ok).toBe(true)
    expect(getTask(db, taskId)?.status).toBe('done') // the work happened
    const budget = getBudget(db, 'agent', agentRow.id)
    expect(budget?.spentUsdCents).toBeGreaterThan(0) // spend is no longer invisible
    expect(budget?.status).toBe('paused') // the cap engaged on the estimate
    expect(getComments(db, taskId).some((c) => c.body.includes('Budget cap reached'))).toBe(true)
  })

  it('a PRE-FLIGHT paused cap blocks the next dispatch (no claim, no exec, no chat.send)', async () => {
    const agentRow = seedAgent()
    const run = seedRoutine(agentRow.id)
    const taskId = seedTask()
    const client = new FakeOperatorClient()
    // A cap-mode budget already over its limit → paused.
    setBudgetLimit(db, { scope: 'agent', scopeId: agentRow.id, limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', agentRow.id, 150)
    expect(getBudget(db, 'agent', agentRow.id)?.status).toBe('paused')

    const outcome = await dispatchConnectedSubstrate({
      db,
      run,
      template: TEMPLATE,
      agentRow,
      taskId,
      client: client as unknown as OperatorClientLike,
    })

    expect(outcome.ok).toBe(false)
    expect(outcome.error).toContain('budget_paused')
    expect(getTask(db, taskId)?.status).toBe('todo') // never claimed
    expect(listExecutions(db, taskId)).toHaveLength(0) // never started
    expect(client.calls.some((c) => c.method === 'chat.send')).toBe(false) // never dispatched
  })

  it('lands `done` over a stale non-promotable verdict via the audited override (no silent block)', async () => {
    const agentRow = seedAgent()
    const run = seedRoutine(agentRow.id)
    const taskId = seedTask()
    const client = new FakeOperatorClient()
    const sessionKey = `agent:gw-${agentRow.id}:clawboo-routine-${run.id}`
    // A failing verdict from a prior runtime sits on the task; the intrinsic gate
    // would block the connected-substrate `done` without the explicit override.
    setTaskVerification(db, taskId, {
      status: 'fail',
      attempts: [
        {
          attempt: 1,
          at: Date.now(),
          deterministic: {
            command: 'pnpm test',
            exitCode: 1,
            passed: false,
            stdoutTail: '',
            stderrTail: '',
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

    const dispatchPromise = dispatchConnectedSubstrate({
      db,
      run,
      template: TEMPLATE,
      agentRow,
      taskId,
      client: client as unknown as OperatorClientLike,
    })
    await new Promise((resolve) => setImmediate(resolve))
    client.emit(
      chatFrame(sessionKey, 'final', { message: { role: 'assistant', content: 'all done' } }),
    )
    await dispatchPromise

    expect(getTask(db, taskId)?.status).toBe('done') // not silently stuck in_review
  })

  it('records TERMINAL cost against budgets when a future Gateway puts costUsd on the done event', async () => {
    const agentRow = seedAgent()
    const run = seedRoutine(agentRow.id)
    const taskId = seedTask()
    const client = new FakeOperatorClient()
    setBudgetLimit(db, { scope: 'agent', scopeId: agentRow.id, limitUsdCents: 100, mode: 'cap' })

    // Forward-compatible path: a future cost-bearing Gateway puts the real cost on
    // the terminal `done.costUsd`. The injected adapter models that future frame —
    // the REAL current path (no costUsd → estimate) is covered by the test above.
    const queue = createAsyncQueue<RuntimeEvent>({ max: 100 })
    const outcome = await dispatchConnectedSubstrate({
      db,
      run,
      template: TEMPLATE,
      agentRow,
      taskId,
      client: client as unknown as OperatorClientLike,
      makeAdapter: () => ({
        start: async () => {
          queue.push({
            kind: 'done',
            runId: 'run-1',
            sessionId: 'sk',
            ts: 1,
            seq: 1,
            reason: 'success',
            summary: 'done the work',
            costUsd: 2.5, // 250¢ — over the 100¢ cap
            usage: { inputTokens: 10, outputTokens: 10 },
          } as RuntimeEvent)
          return { adapterId: 'openclaw', sessionKey: 'sk', runId: 'run-1' }
        },
        events: () => queue,
        abort: async () => {},
      }),
    })

    expect(outcome.ok).toBe(true)
    expect(getTask(db, taskId)?.status).toBe('done') // the run already finished; no mid-run abort
    // Terminal cost was recorded → the cap-mode budget is now paused (it would
    // pause the NEXT fire) — proving OpenClaw spend is no longer invisible.
    expect(getBudget(db, 'agent', agentRow.id)?.status).toBe('paused')
    expect(getBudget(db, 'agent', agentRow.id)?.spentUsdCents).toBe(250)
  })

  it('a usage-but-NULL-cost incremental `cost` event does NOT suppress the terminal estimate', async () => {
    // A future Gateway that streams usage-but-null-cost `cost` events (the Codex/Hermes
    // shape) must NOT flip
    // `recordedAnyCost` and zero out the run's spend — the terminal text-estimate must
    // still fire so the cap engages. The injected adapter models that future frame.
    const agentRow = seedAgent()
    const run = seedRoutine(agentRow.id)
    const taskId = seedTask()
    const client = new FakeOperatorClient()
    setBudgetLimit(db, { scope: 'agent', scopeId: agentRow.id, limitUsdCents: 1, mode: 'cap' })

    const queue = createAsyncQueue<RuntimeEvent>({ max: 100 })
    const outcome = await dispatchConnectedSubstrate({
      db,
      run,
      template: TEMPLATE,
      agentRow,
      taskId,
      client: client as unknown as OperatorClientLike,
      makeAdapter: () => ({
        start: async () => {
          // A usage-but-NULL-cost incremental event (records $0), then a done with NO
          // costUsd → the dispatcher must STILL estimate spend from the produced text.
          queue.push({
            kind: 'cost',
            runId: 'r',
            sessionId: 'sk',
            ts: 1,
            seq: 1,
            costUsd: null,
            usage: { inputTokens: 10, outputTokens: 10 },
            model: 'gw',
          } as RuntimeEvent)
          queue.push({
            kind: 'done',
            runId: 'r',
            sessionId: 'sk',
            ts: 2,
            seq: 2,
            reason: 'success',
            summary: 'x'.repeat(8000),
          } as RuntimeEvent)
          return { adapterId: 'openclaw', sessionKey: 'sk', runId: 'r' }
        },
        events: () => queue,
        abort: async () => {},
      }),
    })

    expect(outcome.ok).toBe(true)
    const budget = getBudget(db, 'agent', agentRow.id)
    expect(budget?.spentUsdCents).toBeGreaterThan(0) // the estimate was NOT suppressed by the null-cost event
    expect(budget?.status).toBe('paused') // the 1¢ cap engaged on the estimate
  })

  it('surfaces an UNVERIFIED connected-substrate completion (comment + audit), not a silent done', async () => {
    const agentRow = seedAgent()
    const run = seedRoutine(agentRow.id)
    const taskId = seedTask()
    const client = new FakeOperatorClient()
    const sessionKey = `agent:gw-${agentRow.id}:clawboo-routine-${run.id}`

    const dispatchPromise = dispatchConnectedSubstrate({
      db,
      run,
      template: TEMPLATE,
      agentRow,
      taskId,
      client: client as unknown as OperatorClientLike,
    })
    await new Promise((resolve) => setImmediate(resolve))
    client.emit(
      chatFrame(sessionKey, 'final', { message: { role: 'assistant', content: 'all done' } }),
    )
    await dispatchPromise

    expect(getTask(db, taskId)?.status).toBe('done')
    expect(
      getComments(db, taskId).some((c) => c.body.toLowerCase().includes('without verification')),
    ).toBe(true)
    const audit = listGovernanceAudit(db, { eventType: 'verification' })
    expect(audit.some((row) => String(row.summary).includes('connected_substrate'))).toBe(true)
  })

  it('serializes two concurrent fires for ONE OpenClaw agent; different agents run in parallel', async () => {
    // The ticker dispatches due fires CONCURRENTLY and the connected substrate has
    // no per-home mutex, so two routine fires for ONE agent must not open two
    // overlapping sessions on it. A per-gatewayAgent mutex serializes them.
    const tracker = { active: 0, max: 0 }
    const slowAdapter = () => {
      const queue = createAsyncQueue<RuntimeEvent>({ max: 10 })
      return {
        start: async () => {
          tracker.active += 1
          tracker.max = Math.max(tracker.max, tracker.active)
          setTimeout(() => {
            tracker.active -= 1
            queue.push({
              kind: 'done',
              runId: 'r',
              sessionId: 's',
              ts: 1,
              seq: 1,
              reason: 'success',
              summary: 'ok',
            } as RuntimeEvent)
          }, 40)
          return { adapterId: 'openclaw', sessionKey: 's', runId: 'r' }
        },
        events: () => queue,
        abort: async () => {},
      }
    }
    const fireFor = (agentRow: DbAgent) =>
      dispatchConnectedSubstrate({
        db,
        run: seedRoutine(agentRow.id),
        template: TEMPLATE,
        agentRow,
        taskId: seedTask(),
        client: new FakeOperatorClient() as unknown as OperatorClientLike,
        makeAdapter: slowAdapter,
      })

    // Two fires for the SAME agent → serialized (max concurrency 1).
    const shared = seedAgent('oc-shared')
    const [o1, o2] = await Promise.all([fireFor(shared), fireFor(shared)])
    expect(o1.ok && o2.ok).toBe(true)
    expect(tracker.max).toBe(1)

    // Two fires for DIFFERENT agents → parallel (the mutex is per-gatewayAgent).
    tracker.active = 0
    tracker.max = 0
    await Promise.all([fireFor(seedAgent('oc-a')), fireFor(seedAgent('oc-b'))])
    expect(tracker.max).toBe(2)
  })

  it('a LOST claim is satisfied (drop, never retry)', async () => {
    const agentRow = seedAgent()
    const run = seedRoutine(agentRow.id)
    const taskId = seedTask()
    // Pre-claim the task so the dispatcher's claim loses.
    const { claimTask } = await import('@clawboo/db')
    expect(claimTask(db, taskId, 'someone-else', 'openclaw').ok).toBe(true)

    const outcome = await dispatchConnectedSubstrate({
      db,
      run,
      template: TEMPLATE,
      agentRow,
      taskId,
      client: new FakeOperatorClient() as unknown as OperatorClientLike,
    })
    expect(outcome).toMatchObject({ ok: true, taskId })
  })
})
