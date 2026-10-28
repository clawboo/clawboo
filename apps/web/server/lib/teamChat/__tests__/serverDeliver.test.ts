// serverDeliver test — the run primitive's orchestration-specific behavior, with
// a SCRIPTED fake adapter (the real driver factory + home mutex are bypassed via
// the `makeAdapterForAgent` seam). Asserts the four load-bearing rules from the
// adversarial review: deliver resolves AFTER start (detached drain, not after the
// run); the drain BREAKS on the terminal and forwards every event to onEvent;
// markIdle runs BEFORE onEvent(done); the abort map is populated then evicted; the
// no-terminal path calls onSessionClosed; an immediate start failure rejects; and
// a paused CAP budget aborts the run (the kill-switch).

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agents,
  createExecutionProcess,
  createTask,
  enqueueInbox,
  getBudget,
  getTask,
  listEvents,
  listExecutions,
  listUndeliveredInbox,
  postToRoom,
  resolveRoomForTeam,
  setBudgetLimit,
  setSetting,
  teams,
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
import { DEFAULT_AGENT_CONFIG } from '@clawboo/adapter-native'
import { createNudgeQueue, type NudgeQueue, type RunStamp } from '@clawboo/team-orchestration'

import { getDb, resetDb } from '../../db'
import { homeDispatchMutex } from '../../executorRunner'
import { estimateRunCostUsd, estimateRunCostUsdFromUsage } from '../../runtimes/estimateCost'
import { runtimeIdentityHomePath } from '../../runtimes/identityHome'
import { saveAgentConfig } from '../../runtimes/native/agentConfigStore'
import { HUMAN_TURN, SYSTEM_TURN } from '@clawboo/team-orchestration'
import { createServerDeliver, type RunEntry } from '../serverDeliver'

const CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
}
/** A persistent per-identity home, so an injected FakeAdapter takes the home
 *  mutex exactly as a native run does. */
const PERSISTENT_CAPS: Capabilities = {
  ...CAPS,
  nativeHome: { scope: 'per-identity', persist: true },
}

const SK = 'agent:a1:team:T'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

/** Hold a1's home lock (as a sibling run would) until the gate opens. Resolves
 *  once the lock is released. */
function hold(gate: Promise<void>): Promise<void> {
  return homeDispatchMutex.run(runtimeIdentityHomePath('fake-native', 'a1'), () => gate)
}

const base = (
  sk: string,
  seq: number,
): { runId: string; sessionId: string; ts: number; seq: number } => ({
  runId: sk,
  sessionId: sk,
  ts: seq,
  seq,
})

/** A scripted RuntimeAdapter: yields a provided async event sequence; counts start/abort. */
class FakeAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'fake-native'
  startCalls = 0
  aborted = 0
  lastStartOpts: StartOpts | null = null
  startOptsLog: StartOpts[] = []
  constructor(
    private readonly gen: (run: RunHandle) => AsyncIterable<RuntimeEvent>,
    private readonly onStart?: () => void,
    private readonly caps: Capabilities = CAPS,
  ) {}
  capabilities(): Capabilities {
    return this.caps
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startCalls += 1
    this.lastStartOpts = opts
    this.startOptsLog.push(opts)
    this.onStart?.()
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    return this.gen(run)
  }
  async abort(): Promise<void> {
    this.aborted += 1
  }
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

describe('serverDeliver (adapter run + event drain — NOT runTaskOnRuntime)', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-deliver-home-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = getDb()
  })
  afterEach(async () => {
    // Close BEFORE removing the dir: Windows refuses to remove a directory
    // that still holds an open file. (#140)
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  function wire(
    adapter: FakeAdapter,
    opts?: {
      taskId?: string | null
      persistReturns?: boolean
      /** One-shot: the FIRST `onEvent(done)` awaits this before returning —
       *  simulates the engine's real (slow) board I/O on a terminal, the window
       *  in which a markIdle-flushed successor run starts. */
      firstDoneGate?: Promise<void>
      /** The engine's live session map, read on every call. Overrides `taskId`. */
      taskForSession?: (sk: string) => string | null
      /** The host's Stop generation. Defaults to a constant 0. */
      stopGen?: () => number
      /** Runs inside the engine stub for each forwarded event, before it returns. */
      onEngineEvent?: (sk: string, e: RuntimeEvent) => void
      /** The execution row the engine names for a task run. Defaults to none. */
      execId?: string | null
      /** Runs inside the engine's `onSessionClosed` stub, before it returns. */
      onClose?: (sk: string) => void
    },
  ) {
    let doneGateUsed = false
    const order: string[] = []
    const events: RuntimeEvent[] = []
    const stamps: RunStamp[] = []
    const closedStamps: RunStamp[] = []
    const closed: string[] = []
    const persisted: Array<{ sk: string; text: string }> = []
    const deltas: Array<{ sk: string; runId: string | null; text: string }> = []
    const statuses: Array<{ agentId: string; status: string }> = []
    const metas: Array<{ sk: string; text: string }> = []
    const abortMap = new Map<string, RunEntry>()
    const real = createNudgeQueue()
    // Wrap markBusy/markIdle to record ordering vs onEvent.
    const nudge: NudgeQueue = {
      deliver: (sk, send) => real.deliver(sk, send),
      markBusy: (sk) => {
        order.push('busy')
        real.markBusy(sk)
      },
      markIdle: (sk) => {
        order.push('idle')
        real.markIdle(sk)
      },
      isBusy: (sk) => real.isBusy(sk),
      drain: () => real.drain(),
      reset: () => real.reset(),
    }
    const deliver = createServerDeliver({
      db,
      teamId: 'T',
      mcpBaseUrl: null,
      nudge,
      abortMap,
      onEvent: async (sk, e, run) => {
        order.push(`event:${e.kind}`)
        events.push(e)
        stamps.push(run)
        opts?.onEngineEvent?.(sk, e)
        if (e.kind === 'done' && opts?.firstDoneGate && !doneGateUsed) {
          doneGateUsed = true
          await opts.firstDoneGate
        }
      },
      onSessionClosed: async (sk, run) => {
        opts?.onClose?.(sk)
        closed.push(sk)
        closedStamps.push(run)
      },
      taskForSession: opts?.taskForSession ?? (() => opts?.taskId ?? null),
      execForSession: () => opts?.execId ?? null,
      stopGen: opts?.stopGen ?? (() => 0),
      leaderAgentId: () => 'leader',
      persistTurn: (sk, text) => {
        persisted.push({ sk, text })
        // Default (undefined) counts as persisted — the legacy-stub contract; an
        // explicit false simulates a write-time drop / insert error.
        return opts?.persistReturns
      },
      persistMeta: (sk, text) => {
        metas.push({ sk, text })
        return true
      },
      publishDelta: (sk, runId, text) => deltas.push({ sk, runId, text }),
      publishStatus: (agentId, status) => statuses.push({ agentId, status }),
      makeAdapterForAgent: () => adapter,
    })
    return {
      deliver,
      order,
      events,
      stamps,
      closed,
      closedStamps,
      persisted,
      metas,
      deltas,
      statuses,
      abortMap,
      nudge,
    }
  }

  it('resolves AFTER start (detached drain), forwards events, markIdle precedes onEvent(done), evicts the abort map, persists the terminal', async () => {
    const gate = deferred()
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'text-delta',
          text: 'all done',
          channel: 'assistant',
        }
        await gate.promise
        yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'all done' }
      })(),
    )
    const w = wire(adapter)

    await w.deliver(SK, 'a1', 'hello', HUMAN_TURN)
    // deliver resolved after start — the run is tracked but the drain is still gated.
    expect(adapter.startCalls).toBe(1)
    expect(w.abortMap.has(SK)).toBe(true)
    await tick()
    expect(w.events.map((e) => e.kind)).toEqual(['text-delta'])

    gate.resolve()
    await tick()
    await tick()
    expect(w.events.map((e) => e.kind)).toEqual(['text-delta', 'done'])
    expect(w.abortMap.has(SK)).toBe(false) // evicted on terminal
    expect(w.persisted).toEqual([{ sk: SK, text: 'all done' }])
    // markIdle ran BEFORE onEvent(done) (load-bearing).
    const idleIdx = w.order.indexOf('idle')
    const doneIdx = w.order.indexOf('event:done')
    expect(idleIdx).toBeGreaterThanOrEqual(0)
    expect(idleIdx).toBeLessThan(doneIdx)
  })

  it('a DELEGATED-CHILD task turn neither STREAMS nor COMMITS into chat (its output lives on the board card)', async () => {
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'text-delta', text: 'poem', channel: 'assistant' }
        yield {
          ...base(run.sessionKey, 2),
          kind: 'done',
          reason: 'success',
          summary: 'a lovely poem',
        }
      })(),
    )
    const w = wire(adapter, { taskId: 'task-1' })
    await w.deliver(SK, 'a1', 'write a poem', {
      kind: 'delegation',
      fromAgentId: 'leader',
    })
    for (let i = 0; i < 4; i++) await tick()
    // The terminal still flows through the engine (the board lifecycle owns it)…
    expect(w.events.map((e) => e.kind)).toEqual(['text-delta', 'done'])
    // …but the turn is NOT surfaced in the chat timeline: only a leader / user-facing
    // turn (one with no board task) streams OR commits there. A delegated child's
    // output is shown on its BoardTaskCard via the engine's report-up comment. Both
    // gates matter: without suppressing the stream, the child's StreamingCard would
    // never clear (its committed turn is suppressed) and stick on screen forever.
    expect(w.persisted).toEqual([])
    expect(w.deltas).toEqual([])
  })

  it('a LEADER DELEGATION turn (calls the `delegate` tool) still STREAMS and COMMITS its prose — streamed replies must never vanish', async () => {
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        // A leader delegates via the `delegate` tool, then narrates around it.
        yield {
          ...base(run.sessionKey, 1),
          kind: 'tool-call',
          toolCallId: 't1',
          name: 'delegate',
          input: { assignee: 'X', task: 'poem' },
          partial: false,
        }
        yield {
          ...base(run.sessionKey, 2),
          kind: 'text-delta',
          text: 'Handed off, working on it',
          channel: 'assistant',
        }
        yield {
          ...base(run.sessionKey, 3),
          kind: 'done',
          reason: 'success',
          summary: 'Handed off, working on it',
        }
      })(),
    )
    const w = wire(adapter) // no taskId → a leader / user-facing session
    await w.deliver(SK, 'leader', 'ask 2 teammates for a poem', HUMAN_TURN)
    for (let i = 0; i < 5; i++) await tick()
    // The old delegation-turn suppression is RETIRED: it made prose the user had
    // already watched streaming disappear (nothing ever replaced the StreamingCard).
    // A leader turn's prose now streams and commits whether or not it delegated —
    // the delegation itself still surfaces as durable BoardTaskCards, and a
    // pure-delegation turn with NO prose still renders nothing (client-side strip).
    expect(w.deltas.map((d) => d.text)).toEqual(['Handed off, working on it'])
    expect(w.persisted).toEqual([{ sk: SK, text: 'Handed off, working on it' }])
  })

  it('publishes running → idle status at the run boundaries (leader AND delegated child)', async () => {
    const mk = () =>
      new FakeAdapter((run) =>
        (async function* () {
          yield { ...base(run.sessionKey, 1), kind: 'text-delta', text: 'hi', channel: 'assistant' }
          yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'hi there' }
        })(),
      )
    // Leader / user-facing turn.
    const leader = wire(mk())
    await leader.deliver(SK, 'a1', 'hello', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(leader.statuses).toEqual([
      { agentId: 'a1', status: 'running' },
      { agentId: 'a1', status: 'idle' },
    ])
    // Delegated child: chat-invisible, but the left-pane badge still tracks it.
    const child = wire(mk(), { taskId: 'task-1' })
    await child.deliver(SK, 'a1', 'subtask', { kind: 'delegation', fromAgentId: 'leader' })
    for (let i = 0; i < 4; i++) await tick()
    expect(child.statuses).toEqual([
      { agentId: 'a1', status: 'running' },
      { agentId: 'a1', status: 'idle' },
    ])
  })

  it('a fatal error terminal commits the partial streamed text + publishes an error status', async () => {
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'text-delta',
          text: 'partial answer',
          channel: 'assistant',
        }
        yield {
          ...base(run.sessionKey, 2),
          kind: 'error',
          code: 'provider_down',
          message: 'boom',
          fatal: true,
        }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    // What the user watched streaming survives the failure as a committed turn…
    expect(w.persisted).toEqual([{ sk: SK, text: 'partial answer' }])
    // …and the badge flips to error, not a silent stuck-Working.
    expect(w.statuses.at(-1)).toEqual({ agentId: 'a1', status: 'error' })
    // The partial IS the explanation, so no system notice is added on top of it.
    expect(w.metas).toEqual([])
  })

  it('a fatal error BEFORE any text posts a system notice with the reason', async () => {
    // Otherwise this is a silent non-response: the turn just never arrives, which
    // reads exactly like an agent that decided not to answer. The classic cause
    // is a missing provider key, so the notice says where to fix it.
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'error',
          code: 'auth',
          message: 'no provider key available (checked ANTHROPIC_API_KEY and fallbacks)',
          fatal: true,
        }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()

    expect(w.metas).toHaveLength(1)
    expect(w.metas[0]?.sk).toBe(SK)
    expect(w.metas[0]?.text).toMatch(/no provider key connected/i)
    expect(w.metas[0]?.text).toMatch(/Settings/)
    // It is a notice, not the agent's turn.
    expect(w.persisted).toEqual([])
    expect(w.statuses.at(-1)).toEqual({ agentId: 'a1', status: 'error' })
  })

  it('an unrecognized failure still reports its reason rather than nothing', async () => {
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'error',
          code: 'provider_down',
          message: 'upstream 503',
          fatal: true,
        }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(w.metas[0]?.text).toBe('The run failed: upstream 503')
  })

  it("an Ollama agent's missing-model failure names the pull command", async () => {
    // The provider comes from the agent's own config, so the same words from a
    // non-Ollama agent (below) stay verbatim.
    saveAgentConfig(db, {
      ...DEFAULT_AGENT_CONFIG,
      id: 'a1',
      name: 'A1',
      primaryProvider: 'ollama',
      primaryModel: 'llama3.2',
      envVar: 'OLLAMA_BASE_URL',
      createdAt: 0,
      updatedAt: 0,
    })
    const failing = () =>
      new FakeAdapter((run) =>
        (async function* () {
          yield {
            ...base(run.sessionKey, 1),
            kind: 'error',
            code: 'bad_request',
            message: "404 model 'llama3.2' not found",
            fatal: true,
          }
        })(),
      )
    const w = wire(failing())
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(w.metas[0]?.text).toContain('"ollama pull llama3.2"')

    const other = wire(failing())
    await other.deliver(SK, 'a2', 'hi', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(other.metas[0]?.text).toBe("The run failed: 404 model 'llama3.2' not found")
  })

  it('a stream that ends with NO terminal also says so instead of going quiet', async () => {
    // The other half of the same silence: the iterator just stops (a dropped
    // connection, a crashed harness) and no event ever explains why. The engine
    // is told, the badge clears, and before this the chat showed nothing at all.
    const adapter = new FakeAdapter(() =>
      (async function* () {
        // Ends immediately: no text, no done, no error.
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()

    expect(w.metas).toHaveLength(1)
    expect(w.metas[0]?.text).toMatch(/ended without reporting a result/i)
    expect(w.persisted).toEqual([])
  })

  it('a dead stream COMMITS the partial the user watched instead of replacing it with a notice', async () => {
    // The fatal-error terminal already does this. A stream that just stops has to
    // agree: the text was on screen, and clearing it to say "nothing came back"
    // both loses real content and contradicts what the user saw.
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'text-delta',
          text: 'half an answer',
          channel: 'assistant',
        }
        // Iterator ends here: no done, no error.
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()

    expect(w.persisted).toEqual([{ sk: SK, text: 'half an answer' }])
    expect(w.metas).toEqual([])
    // The committed card replaces the StreamingCard, so no clearing delta.
    expect(w.deltas.filter((d) => d.text === '')).toEqual([])
  })

  it('a committed turn followed by a dead stream posts no notice', async () => {
    // The turn arrived; the stream dying afterwards is not the user's problem.
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'all done' }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(w.persisted).toEqual([{ sk: SK, text: 'all done' }])
    expect(w.metas).toEqual([])
  })

  it('a user Stop stays silent: an abort nobody explained is the one the user chose', async () => {
    // Every runtime reports an abort as a clean `done: aborted`, so this terminal
    // is byte-identical to the server-kill cases below. The only thing telling
    // them apart is whether someone recorded a reason, and a user Stop does not.
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'aborted', summary: '' }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(w.metas).toEqual([])
    expect(w.persisted).toEqual([])
  })

  it('a run the SERVER killed reports the kill, not silence', async () => {
    // The budget kill-switch, the idle guard and the wedge all abort the run
    // themselves and all produce `done: aborted`. Reading that as a deliberate
    // stop would hide a cap the user never saw hit.
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 1, mode: 'cap' })
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'cost',
          costUsd: 1.0,
          usage: { inputTokens: 10, outputTokens: 10 },
          model: null,
          estimated: false,
        }
        yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'aborted', summary: '' }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'spendy', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(adapter.aborted).toBeGreaterThanOrEqual(1)
    expect(w.metas).toHaveLength(1)
    expect(w.metas[0]?.text).toMatch(/budget cap/i)
  })

  it('a delegated CHILD run posts no notice: its failure surfaces on the board', async () => {
    // A task run is not chat-visible, so a notice here would appear in a room the
    // user did not address, duplicating the engine's own task-failure reporting.
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'error',
          code: 'auth',
          message: 'no provider key available (checked ANTHROPIC_API_KEY and fallbacks)',
          fatal: true,
        }
      })(),
    )
    const w = wire(adapter, { taskId: 't-1' })
    await w.deliver(SK, 'a1', 'hi', { kind: 'delegation', fromAgentId: 'leader' })
    for (let i = 0; i < 4; i++) await tick()
    expect(w.metas).toEqual([])
  })

  it('an empty-summary done falls back to the ACCUMULATED stream text so a watched turn never vanishes', async () => {
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'text-delta', text: 'Hel', channel: 'assistant' }
        yield { ...base(run.sessionKey, 2), kind: 'text-delta', text: 'lo', channel: 'assistant' }
        yield { ...base(run.sessionKey, 3), kind: 'done', reason: 'aborted', summary: '' }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    for (let i = 0; i < 5; i++) await tick()
    expect(w.persisted).toEqual([{ sk: SK, text: 'Hello' }])
  })

  it('a streamed turn whose commit is DROPPED publishes one CLEARING delta (empty text) so no StreamingCard lingers', async () => {
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'text-delta',
          text: 'Sorry, no.',
          channel: 'assistant',
        }
        yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'Sorry, no.' }
      })(),
    )
    // persistTurn returns false — the write-time control-token/refusal drop.
    const w = wire(adapter, { persistReturns: false })
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(w.deltas.map((d) => d.text)).toEqual(['Sorry, no.', ''])
  })

  it('a stream that ends WITHOUT a terminal → onSessionClosed + abort-map evicted', async () => {
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'text-delta',
          text: 'partial',
          channel: 'assistant',
        }
        // ends with no done / no fatal error
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    await tick()
    await tick()
    expect(w.closed).toEqual([SK])
    expect(w.abortMap.has(SK)).toBe(false)
    // The partial the user watched is COMMITTED rather than cleared. This used to
    // assert the opposite (an empty-text sentinel that dropped the StreamingCard),
    // which threw away text that was on screen; the fatal-error terminal always
    // committed the same partial, so the two paths disagreed about identical
    // content. The committed card replaces the StreamingCard on its own.
    expect(w.persisted).toEqual([{ sk: SK, text: 'partial' }])
    expect(w.deltas.at(-1)?.text).toBe('partial')
    expect(w.statuses.at(-1)).toEqual({ agentId: 'a1', status: 'idle' })
  })

  it('a terminal never evicts the QUEUED SUCCESSOR run that markIdle flushed (slow onEvent(done))', async () => {
    // The race: markIdle synchronously flushes the session's next queued delivery,
    // and for a mutex-less runtime the successor's runJob does `abortMap.set` while
    // run 1 is still awaiting its (slow, real-board-I/O) onEvent(done). A delete
    // left until after that await evicted the SUCCESSOR's entry, hiding the
    // in-flight run from stop() and the wedge abort.
    const gate1 = deferred() // holds run 1 open so delivery #2 FIFO-queues behind it
    const gate2 = deferred() // holds run 2 open so its abort-map entry is inspectable
    const doneGate = deferred() // the slow engine board-I/O on run 1's done
    let call = 0
    const adapter = new FakeAdapter((run) => {
      call += 1
      if (call === 1)
        return (async function* () {
          yield {
            ...base(run.sessionKey, 1),
            kind: 'text-delta',
            text: 'first',
            channel: 'assistant',
          }
          await gate1.promise
          yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'first' }
        })()
      return (async function* () {
        yield {
          ...base(run.sessionKey, 3),
          kind: 'text-delta',
          text: 'second',
          channel: 'assistant',
        }
        await gate2.promise
        yield { ...base(run.sessionKey, 4), kind: 'done', reason: 'success', summary: 'second' }
      })()
    })
    const w = wire(adapter, { firstDoneGate: doneGate.promise })

    await w.deliver(SK, 'a1', 'one', HUMAN_TURN) // run 1 in flight (nudge marked the session busy)
    const p2 = w.deliver(SK, 'a1', 'two', HUMAN_TURN) // queued behind run 1
    gate1.resolve() // run 1 reaches its terminal → evict run 1 + markIdle → run 2 flushed
    for (let i = 0; i < 6; i++) await tick()
    // Run 2 started while run 1 still awaits its slow onEvent(done)…
    expect(adapter.startCalls).toBe(2)
    expect(w.abortMap.has(SK)).toBe(true) // …and its entry is tracked
    doneGate.resolve() // run 1's drain finishes its terminal handling
    for (let i = 0; i < 4; i++) await tick()
    // THE REGRESSION: run 1's cleanup must NOT have evicted run 2's live entry.
    expect(w.abortMap.has(SK)).toBe(true)
    await p2
    gate2.resolve() // run 2 completes normally → its own terminal evicts it
    for (let i = 0; i < 4; i++) await tick()
    expect(w.abortMap.has(SK)).toBe(false)
  })

  it('an immediate start failure rejects deliver (so the engine fails the task now, not after the watchdog)', async () => {
    const adapter = new FakeAdapter(
      () => (async function* () {})(),
      () => {
        throw new Error('boom')
      },
    )
    const w = wire(adapter)
    await expect(w.deliver(SK, 'a1', 'hi', HUMAN_TURN)).rejects.toThrow('boom')
    expect(w.abortMap.has(SK)).toBe(false)
  })

  // ── The start gate: a delivery starts only while it is still wanted ─────────

  it('a delegation whose task is RELEASED while it waits on the home lock never starts', async () => {
    // A sibling run holds the agent's home lock. While this delegation waits, the
    // engine releases its task (a stale sweep, a person moving the card), so the
    // run would do work nobody tracks and stream it as if it were wanted.
    const lock = deferred()
    const held = hold(lock.promise)
    let task: string | null = 't-1'
    const adapter = new FakeAdapter(
      (run) =>
        (async function* () {
          yield {
            ...base(run.sessionKey, 1),
            kind: 'text-delta',
            text: 'late work',
            channel: 'assistant',
          }
          yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'late' }
        })(),
      undefined,
      PERSISTENT_CAPS,
    )
    const w = wire(adapter, { taskForSession: () => task })
    const p = w.deliver(SK, 'a1', 'do the task', { kind: 'delegation', fromAgentId: 'leader' })
    for (let i = 0; i < 4; i++) await tick()
    expect(adapter.startCalls).toBe(0) // still waiting on the lock

    task = null
    lock.resolve()
    await held
    // Resolves rather than rejects: a rejection would fail whatever task holds the
    // session now.
    await expect(p).resolves.toBeUndefined()
    for (let i = 0; i < 4; i++) await tick()
    expect(adapter.startCalls).toBe(0)
    expect(w.persisted).toEqual([])
    expect(w.deltas).toEqual([])
    expect(w.statuses).toEqual([])
    // The released slot is free again, so the next turn is not stuck behind it.
    expect(w.nudge.isBusy(SK)).toBe(false)
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    expect(adapter.startCalls).toBe(1)
  })

  it('a delivery made before a Stop never starts after it, and does not un-busy a post-Stop run', async () => {
    const lock = deferred()
    const held = hold(lock.promise)
    let gen = 0
    const gate = deferred()
    const adapter = new FakeAdapter(
      (run) =>
        (async function* () {
          await gate.promise
          yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
        })(),
      undefined,
      PERSISTENT_CAPS,
    )
    const w = wire(adapter, { taskId: 't-1', stopGen: () => gen })
    const p1 = w.deliver(SK, 'a1', 'D1 before the stop', {
      kind: 'delegation',
      fromAgentId: 'leader',
    })
    for (let i = 0; i < 4; i++) await tick()
    // What stop() does: bump the generation, then reset the queue.
    gen = 1
    w.nudge.reset()
    const p2 = w.deliver(SK, 'a1', 'D2 after the stop', HUMAN_TURN)
    lock.resolve()
    await held
    await p1
    await p2
    for (let i = 0; i < 4; i++) await tick()

    expect(adapter.startOptsLog.map((o) => o.message)).toEqual(['D2 after the stop'])
    // D1's refusal left D2's busy mark alone: D2 is still running.
    expect(w.nudge.isBusy(SK)).toBe(true)
    gate.resolve()
    for (let i = 0; i < 4; i++) await tick()
    expect(w.nudge.isBusy(SK)).toBe(false)
  })

  /** Two-run adapter: run 1 ends `done: aborted` on `g1`, every later run `done` on `g2`. */
  function twoRunAdapter(caps: Capabilities = CAPS): {
    adapter: FakeAdapter
    g1: ReturnType<typeof deferred>
    g2: ReturnType<typeof deferred>
  } {
    const g1 = deferred()
    const g2 = deferred()
    let n = 0
    const adapter = new FakeAdapter(
      (run) => {
        const mine = ++n
        return (async function* () {
          if (mine === 1) {
            await g1.promise
            yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'aborted', summary: '' }
          } else {
            await g2.promise
            yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'r' }
          }
        })()
      },
      undefined,
      caps,
    )
    return { adapter, g1, g2 }
  }

  it('a pre-Stop run ending after the Stop keeps off the post-Stop run (abort entry and busy mark)', async () => {
    // claude-code takes no lock, so a run delivered after a Stop starts while
    // the run the Stop aborted is still winding down.
    let gen = 0
    const { adapter, g1, g2 } = twoRunAdapter()
    const w = wire(adapter, { stopGen: () => gen })
    await w.deliver(SK, 'leader', 'D1', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    const d1 = w.abortMap.get(SK)?.run
    // What stop() does: bump the generation, abort the map's runs, reset the queue.
    gen = 1
    for (const [, e] of w.abortMap) void e.adapter.abort(e.run)
    w.nudge.reset()
    await w.deliver(SK, 'leader', 'D2', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    const d2 = w.abortMap.get(SK)?.run
    expect(d2).toBeDefined()
    expect(d2).not.toBe(d1)

    g1.resolve() // D1's aborted terminal lands while D2 runs
    for (let i = 0; i < 6; i++) await tick()
    expect(w.abortMap.get(SK)?.run).toBe(d2) // a second Stop still reaches D2
    expect(w.nudge.isBusy(SK)).toBe(true)
    // So a third message queues behind D2 instead of starting beside it.
    void w.deliver(SK, 'leader', 'D3', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(adapter.startCalls).toBe(2)
    g2.resolve()
    for (let i = 0; i < 6; i++) await tick()
    expect(adapter.startCalls).toBe(3) // D2's own end released D3
  })

  it('a pre-Stop run ending after the Stop leaves a post-Stop run waiting on the lock busy', async () => {
    let gen = 0
    const { adapter, g1, g2 } = twoRunAdapter(PERSISTENT_CAPS)
    const w = wire(adapter, { stopGen: () => gen })
    await w.deliver(SK, 'a1', 'D1', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    gen = 1
    for (const [, e] of w.abortMap) void e.adapter.abort(e.run)
    w.nudge.reset()
    const p2 = w.deliver(SK, 'a1', 'D2', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(adapter.startCalls).toBe(1) // D2 waits on the home lock D1's drain holds
    g1.resolve()
    await p2
    expect(adapter.startCalls).toBe(2)
    expect(w.nudge.isBusy(SK)).toBe(true) // D2 is running
    g2.resolve()
    for (let i = 0; i < 6; i++) await tick()
    expect(w.nudge.isBusy(SK)).toBe(false)
  })

  it('a pre-Stop run still streaming after the Stop does not re-busy the session', async () => {
    let gen = 0
    const g1 = deferred()
    let n = 0
    const adapter = new FakeAdapter((run) => {
      const mine = ++n
      return (async function* () {
        if (mine === 1) {
          await g1.promise
          yield {
            ...base(run.sessionKey, 1),
            kind: 'text-delta',
            text: 'late',
            channel: 'assistant',
          }
          yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'aborted', summary: '' }
        } else {
          yield { ...base(run.sessionKey, 3), kind: 'done', reason: 'success', summary: 'r' }
        }
      })()
    })
    const w = wire(adapter, { stopGen: () => gen })
    await w.deliver(SK, 'leader', 'D1', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    gen = 1
    w.nudge.reset()
    g1.resolve() // D1 streams once more, then ends
    for (let i = 0; i < 6; i++) await tick()
    expect(w.nudge.isBusy(SK)).toBe(false)
    await w.deliver(SK, 'leader', 'D2', HUMAN_TURN)
    expect(adapter.startCalls).toBe(2) // started at once, not queued behind a dead run
  })

  it('a wedge-aborted run ending late does not evict the successor the wedge released', async () => {
    const { adapter, g1, g2 } = twoRunAdapter()
    const w = wire(adapter)
    await w.deliver(SK, 'leader', 'D1', HUMAN_TURN)
    void w.deliver(SK, 'leader', 'D2', HUMAN_TURN) // queued behind D1
    for (let i = 0; i < 4; i++) await tick()
    // What the wedge does: abort the session's run, then force-idle, which flushes D2.
    const d1 = w.abortMap.get(SK)
    if (d1) void d1.adapter.abort(d1.run)
    w.nudge.markIdle(SK)
    for (let i = 0; i < 4; i++) await tick()
    expect(adapter.startCalls).toBe(2)
    const d2 = w.abortMap.get(SK)?.run
    expect(d2).not.toBe(d1?.run)

    g1.resolve() // D1's aborted terminal lands while D2 runs
    for (let i = 0; i < 6; i++) await tick()
    expect(w.abortMap.get(SK)?.run).toBe(d2)
    g2.resolve()
    for (let i = 0; i < 6; i++) await tick()
    expect(w.abortMap.has(SK)).toBe(false)
  })

  for (const why of ['stop', 'release'] as const) {
    it(`a ${why} DURING adapter.start discards the run: nothing reaches the engine, the chat or the inbox`, async () => {
      enqueueInbox(db, { agentId: 'a1', teamId: 'T', kind: 'task_update', body: 'waiting row' })
      let gen = 0
      let task: string | null = 't-1'
      const adapter = new FakeAdapter(
        (run) =>
          (async function* () {
            yield {
              ...base(run.sessionKey, 1),
              kind: 'text-delta',
              text: 'unwanted',
              channel: 'assistant',
            }
            yield {
              ...base(run.sessionKey, 2),
              kind: 'done',
              reason: 'success',
              summary: 'unwanted',
            }
          })(),
        () => {
          if (why === 'stop') gen = 1
          else task = null
        },
      )
      const w = wire(adapter, { taskForSession: () => task, stopGen: () => gen })
      await expect(
        w.deliver(SK, 'a1', 'do the task', { kind: 'delegation', fromAgentId: 'leader' }),
      ).resolves.toBeUndefined()
      for (let i = 0; i < 6; i++) await tick()

      expect(adapter.startCalls).toBe(1)
      expect(adapter.aborted).toBe(1)
      expect(w.events).toEqual([]) // the engine never saw the run
      expect(w.persisted).toEqual([])
      expect(w.deltas).toEqual([])
      expect(w.statuses.map((s) => s.status)).not.toContain('running')
      expect(w.abortMap.has(SK)).toBe(false)
      // The digest it was rendered with was never delivered: it rides the next run.
      expect(listUndeliveredInbox(db, 'a1', { teamId: 'T' }).map((r) => r.body)).toEqual([
        'waiting row',
      ])
      if (why === 'release') expect(w.nudge.isBusy(SK)).toBe(false)
    })
  }

  it('a Stop during a released run discard leaves the post-Stop run busy', async () => {
    let gen = 0
    let task: string | null = 't-1'
    const discardGate = deferred()
    const g2 = deferred()
    let n = 0
    const adapter: FakeAdapter = new FakeAdapter(
      (run) => {
        const mine = ++n
        return (async function* () {
          if (mine === 1) {
            await discardGate.promise
            yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'aborted', summary: '' }
          } else {
            await g2.promise
            yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'r' }
          }
        })()
      },
      () => {
        // The person moves the card while D1's adapter.start is in flight.
        if (adapter.startCalls === 1) task = null
      },
    )
    const w = wire(adapter, { taskForSession: () => task, stopGen: () => gen })
    await w.deliver(SK, 'a1', 'D1 task', { kind: 'delegation', fromAgentId: 'leader' })
    for (let i = 0; i < 4; i++) await tick()
    expect(adapter.aborted).toBe(1) // gate 3 refused D1 and is discarding it
    // Stop while the discard winds down, then a person's message.
    gen = 1
    w.nudge.reset()
    await w.deliver(SK, 'a1', 'D2 after the stop', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(adapter.startCalls).toBe(2)

    discardGate.resolve() // the discard ends while D2 runs
    for (let i = 0; i < 6; i++) await tick()
    expect(w.nudge.isBusy(SK)).toBe(true)
    // So a third message queues behind D2 instead of starting beside it.
    void w.deliver(SK, 'a1', 'D3', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(adapter.startCalls).toBe(2)
    g2.resolve()
    for (let i = 0; i < 6; i++) await tick()
    expect(adapter.startCalls).toBe(3)
  })

  it('a start FAILURE after a Stop resolves instead of rejecting', async () => {
    let gen = 0
    const adapter = new FakeAdapter(
      () => (async function* () {})(),
      () => {
        gen = 1
        throw new Error('killed by the stop')
      },
    )
    const w = wire(adapter, { stopGen: () => gen })
    await expect(w.deliver(SK, 'a1', 'hi', HUMAN_TURN)).resolves.toBeUndefined()
    expect(w.abortMap.has(SK)).toBe(false)
  })

  it('a start FAILURE after a release resolves, and frees the session', async () => {
    // Rejecting here makes the engine fail (block) whatever task the session
    // holds now, which is not the task this delivery was for.
    let task: string | null = 't-1'
    const adapter = new FakeAdapter(
      () => (async function* () {})(),
      () => {
        task = null
        throw new Error('spawn failed')
      },
    )
    const w = wire(adapter, { taskForSession: () => task })
    await expect(
      w.deliver(SK, 'a1', 'do the task', { kind: 'delegation', fromAgentId: 'leader' }),
    ).resolves.toBeUndefined()
    expect(w.nudge.isBusy(SK)).toBe(false)
  })

  it('a lock wait that times out after a Stop resolves, and leaves the retry alone', async () => {
    // The timeout never reaches runJob's gates. Rejecting here makes the engine
    // fail whatever task the session holds now: the person's retry.
    const lock = deferred()
    const held = hold(lock.promise)
    // D1 waits on the real home lock with a short acquire bound; D2 keeps the
    // default one.
    const realRun = homeDispatchMutex.run.bind(homeDispatchMutex)
    const spy = vi
      .spyOn(homeDispatchMutex, 'run')
      .mockImplementationOnce((key, fn) => realRun(key, fn, { acquireTimeoutMs: 150 }))
    try {
      let gen = 0
      let task: string | null = 'T1'
      const adapter = new FakeAdapter(
        (run) =>
          (async function* () {
            yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
          })(),
        undefined,
        PERSISTENT_CAPS,
      )
      const w = wire(adapter, { taskForSession: () => task, stopGen: () => gen })
      const p1 = w.deliver(SK, 'a1', 'D1 before the stop', {
        kind: 'delegation',
        fromAgentId: 'leader',
      })
      for (let i = 0; i < 4; i++) await tick()
      // What stop() does, then the retry maps the session to a new task.
      gen = 1
      w.nudge.reset()
      task = 'T2'
      const p2 = w.deliver(SK, 'a1', 'D2 the retry', { kind: 'delegation', fromAgentId: 'leader' })

      await expect(p1).resolves.toBeUndefined()
      // D1's timeout left D2's busy mark alone.
      expect(w.nudge.isBusy(SK)).toBe(true)
      expect(adapter.startCalls).toBe(0)

      lock.resolve()
      await held
      await p2
      for (let i = 0; i < 4; i++) await tick()
      expect(adapter.startOptsLog.map((o) => o.message)).toEqual(['D2 the retry'])
    } finally {
      spy.mockRestore()
      lock.resolve()
    }
  })

  it('a lock wait that times out after a release resolves, and frees the session', async () => {
    const lock = deferred()
    const held = hold(lock.promise)
    const realRun = homeDispatchMutex.run.bind(homeDispatchMutex)
    const spy = vi
      .spyOn(homeDispatchMutex, 'run')
      .mockImplementationOnce((key, fn) => realRun(key, fn, { acquireTimeoutMs: 150 }))
    try {
      let task: string | null = 't-1'
      const adapter = new FakeAdapter(() => (async function* () {})(), undefined, PERSISTENT_CAPS)
      const w = wire(adapter, { taskForSession: () => task })
      const p = w.deliver(SK, 'a1', 'do the task', { kind: 'delegation', fromAgentId: 'leader' })
      for (let i = 0; i < 4; i++) await tick()
      task = null
      await expect(p).resolves.toBeUndefined()
      expect(adapter.startCalls).toBe(0)
      expect(w.nudge.isBusy(SK)).toBe(false)
    } finally {
      spy.mockRestore()
      lock.resolve()
      await held
    }
  })

  // ── Follow-ups and chat visibility ───────────────────────────────────────────

  const FOLLOW_UP = { kind: 'system', forTaskId: 'T1' } as const

  it('a FOLLOW-UP neither streams nor commits, and its stamp reaches the engine', async () => {
    // a1 delegated work while running T1, T1 closed, and the work came back. Its
    // reply is a report on T1 for whoever gave it T1, not a chat message.
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'text-delta',
          text: 'combined',
          channel: 'assistant',
        }
        yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'combined' }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', '[Task Update] your sub-task finished', FOLLOW_UP)
    for (let i = 0; i < 4; i++) await tick()
    expect(w.events.map((e) => e.kind)).toEqual(['text-delta', 'done'])
    expect(w.persisted).toEqual([])
    expect(w.deltas).toEqual([])
    for (const s of w.stamps) expect(s).toEqual({ reportForTaskId: 'T1', stopGen: 0 })
  })

  it('a FOLLOW-UP that fails, or ends with no terminal, posts no chat notice', async () => {
    const fatal = wire(
      new FakeAdapter((run) =>
        (async function* () {
          yield {
            ...base(run.sessionKey, 1),
            kind: 'error',
            code: 'provider_down',
            message: 'upstream 503',
            fatal: true,
          }
        })(),
      ),
    )
    await fatal.deliver(SK, 'a1', '[Task Update] done', FOLLOW_UP)
    for (let i = 0; i < 4; i++) await tick()
    expect(fatal.metas).toEqual([])

    const dead = wire(new FakeAdapter(() => (async function* () {})()))
    await dead.deliver(SK, 'a1', '[Task Update] done', FOLLOW_UP)
    for (let i = 0; i < 4; i++) await tick()
    expect(dead.metas).toEqual([])
    // The engine still learns which task the dead follow-up was reporting on.
    expect(dead.closedStamps[0]?.reportForTaskId).toBe('T1')
  })

  it('the same origin delivered to the LEAD is an ordinary, visible synthesis', async () => {
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'synthesis' }
      })(),
    )
    const w = wire(adapter)
    const leadSk = 'agent:leader:team:T'
    await w.deliver(leadSk, 'leader', '[Task Update] done', FOLLOW_UP)
    for (let i = 0; i < 4; i++) await tick()
    expect(w.persisted).toEqual([{ sk: leadSk, text: 'synthesis' }])
    expect(w.stamps[0]?.reportForTaskId).toBeNull()
  })

  it('visibility tracks the ORIGIN, not the session map at drain start (a follow-up behind a task run)', async () => {
    // The follow-up is queued behind a1's own task run. That run's done makes the
    // engine forget the task before the follow-up starts draining, so a map read
    // at drain start called the follow-up a chat turn.
    const gate = deferred()
    let task: string | null = 'T2'
    let call = 0
    const adapter = new FakeAdapter((run) => {
      call += 1
      if (call === 1)
        return (async function* () {
          await gate.promise
          yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'T2 done' }
        })()
      return (async function* () {
        yield {
          ...base(run.sessionKey, 2),
          kind: 'text-delta',
          text: 'follow-up words',
          channel: 'assistant',
        }
        yield {
          ...base(run.sessionKey, 3),
          kind: 'done',
          reason: 'success',
          summary: 'follow-up words',
        }
      })()
    })
    const w = wire(adapter, {
      taskForSession: () => task,
      onEngineEvent: (_sk, e) => {
        if (e.kind === 'done') task = null // the engine's completeForSession
      },
    })
    await w.deliver(SK, 'a1', 'run T2', { kind: 'delegation', fromAgentId: 'leader' })
    const p2 = w.deliver(SK, 'a1', '[Task Update] T1 sub-task done', FOLLOW_UP)
    gate.resolve()
    await p2
    for (let i = 0; i < 6; i++) await tick()
    expect(adapter.startCalls).toBe(2)
    expect(w.persisted).toEqual([])
    expect(w.deltas).toEqual([])
  })

  it("a person's message to an agent holding a task is still persisted and streamed", async () => {
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'text-delta', text: 'yes', channel: 'assistant' }
        yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'yes' }
      })(),
    )
    const w = wire(adapter, { taskId: 't-1' })
    await w.deliver(SK, 'a1', '@Coder are you on it?', HUMAN_TURN)
    for (let i = 0; i < 4; i++) await tick()
    expect(w.persisted).toEqual([{ sk: SK, text: 'yes' }])
    expect(w.deltas.map((d) => d.text)).toEqual(['yes'])
  })

  it('Tier-2 deltas: an assistant text-delta publishes the RUNNING accumulated text; a reasoning delta does not', async () => {
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'text-delta', text: 'Hel', channel: 'assistant' }
        yield { ...base(run.sessionKey, 2), kind: 'text-delta', text: 'lo', channel: 'assistant' }
        // reasoning/thinking trace — must NOT be published to chat
        yield {
          ...base(run.sessionKey, 3),
          kind: 'text-delta',
          text: '(thinking)',
          channel: 'reasoning',
        }
        yield { ...base(run.sessionKey, 4), kind: 'done', reason: 'success', summary: 'Hello' }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
    for (let i = 0; i < 6; i++) await tick()

    // REPLACE semantics: each delta carries the FULL running text; reasoning excluded.
    expect(w.deltas.map((d) => d.text)).toEqual(['Hel', 'Hello'])
    expect(w.deltas.every((d) => d.sk === SK && d.runId === SK)).toBe(true)
    // The committed turn is still the durable source of truth.
    expect(w.persisted).toEqual([{ sk: SK, text: 'Hello' }])
  })

  it('CUMULATIVE deltas (OpenClaw-style, full-text-so-far) are REPLACED not appended — no garbled repeat', async () => {
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        // Each delta carries the FULL running text (cumulative), like the OpenClaw adapter.
        yield {
          ...base(run.sessionKey, 1),
          kind: 'text-delta',
          text: 'We plant',
          channel: 'assistant',
        }
        yield {
          ...base(run.sessionKey, 2),
          kind: 'text-delta',
          text: 'We plant data seeds',
          channel: 'assistant',
        }
        yield {
          ...base(run.sessionKey, 3),
          kind: 'text-delta',
          text: 'We plant data seeds, then grow.',
          channel: 'assistant',
        }
        yield {
          ...base(run.sessionKey, 4),
          kind: 'done',
          reason: 'success',
          summary: 'We plant data seeds, then grow.',
        }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'poem', HUMAN_TURN)
    for (let i = 0; i < 6; i++) await tick()
    // The published running text tracks the cumulative snapshots WITHOUT repetition
    // (the "We plantWe plant…" garble came from `+=`-ing cumulative deltas).
    expect(w.deltas.map((d) => d.text)).toEqual([
      'We plant',
      'We plant data seeds',
      'We plant data seeds, then grow.',
    ])
  })

  it('budget kill-switch: a paused CAP budget aborts the run on a cost event', async () => {
    setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 1, mode: 'cap' })
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield {
          ...base(run.sessionKey, 1),
          kind: 'cost',
          costUsd: 1.0,
          usage: { inputTokens: 10, outputTokens: 10 },
          model: null,
          estimated: false,
        }
        yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'aborted', summary: '' }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'spendy', HUMAN_TURN)
    await tick()
    await tick()
    expect(adapter.aborted).toBeGreaterThanOrEqual(1)
  })

  it('injects a live-roster context for a team run (teammates by name, recipient excluded)', async () => {
    const now = Date.now()
    // Team row first — agents.teamId → teams.id is FK-enforced (foreign_keys=ON).
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team T',
        icon: '🚀',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values([
        {
          id: 'a1',
          name: 'Team Lead',
          gatewayId: 'a1',
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        },
        { id: 'a2', name: 'Coder', gatewayId: 'a2', teamId: 'T', createdAt: now, updatedAt: now },
      ])
      .run()
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'do the thing', HUMAN_TURN) // SK = agent:a1:team:T (recipient a1)
    await tick()
    expect(adapter.lastStartOpts?.context).toContain('Coder')
    expect(adapter.lastStartOpts?.context).not.toContain('Team Lead') // the recipient is excluded
  })

  it('prepends team rules + the user self-intro to the volatile context (with the roster)', async () => {
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team T',
        icon: '🚀',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values([
        {
          id: 'a1',
          name: 'Team Lead',
          gatewayId: 'a1',
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        },
        { id: 'a2', name: 'Coder', gatewayId: 'a2', teamId: 'T', createdAt: now, updatedAt: now },
      ])
      .run()
    // Durable team rules + the onboarding self-intro (the sources /rule + the gate write).
    setSetting(db, 'team-rules:T', JSON.stringify({ content: '- Always answer in French' }))
    setSetting(
      db,
      'team-onboarding:T',
      JSON.stringify({ agentsIntroduced: true, userIntroduced: true, userIntroText: 'I am a PM' }),
    )
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
      })(),
    )
    const w = wire(adapter)
    await w.deliver(SK, 'a1', 'do the thing', HUMAN_TURN)
    await tick()
    const ctx = adapter.lastStartOpts?.context ?? ''
    expect(ctx).toContain('[Team Rules — set by the user, authoritative]')
    expect(ctx).toContain('Always answer in French')
    expect(ctx).toContain('[About the User]')
    expect(ctx).toContain('I am a PM')
    expect(ctx).toContain('Coder') // roster still present
    expect(ctx).not.toContain('Team Lead') // recipient still excluded
  })

  it('a SYSTEM turn to a non-leader is not dressed up as the team lead', async () => {
    // THE BUG. `completeForSession` forgets a worker's session on its terminal, so
    // the next thing delivered there — a late [Task Update] from a sub-task, an
    // alert, a peer signal — found no task and was framed as the leader's turn:
    // "You are the LEAD of this team" plus the user's personal intro, handed to an
    // agent that is neither leading nor talking to anyone.
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team T',
        icon: '🚀',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values([
        {
          id: 'leader',
          name: 'Team Lead',
          gatewayId: 'leader',
          teamId: 'T',
          runtime: 'clawboo-native',
          createdAt: now,
          updatedAt: now,
        },
        {
          id: 'a1',
          name: 'Coder',
          gatewayId: 'a1',
          teamId: 'T',
          runtime: 'clawboo-native',
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run()
    setSetting(
      db,
      'team-onboarding:T',
      JSON.stringify({ agentsIntroduced: true, userIntroduced: true, userIntroText: 'I am a PM' }),
    )
    const mk = () =>
      new FakeAdapter((run) =>
        (async function* () {
          yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
        })(),
      )

    // `taskForSession` returns null: the task this agent was running is over.
    const worker = mk()
    await wire(worker).deliver(SK, 'a1', '[Task Update] a sub-task finished', SYSTEM_TURN)
    await tick()
    const workerCtx = worker.lastStartOpts?.context ?? ''
    expect(workerCtx).not.toContain('[About the User]')
    expect(workerCtx).not.toContain('I am a PM')
    expect(workerCtx).not.toContain('[Leading this team')
    expect(workerCtx).toContain('Team Lead') // it still sees the roster

    // The SAME message to the actual leader keeps both: its synthesis of a
    // reflection is what the user reads, so withholding the intro there would
    // trade one bug for another.
    const lead = mk()
    await wire(lead).deliver(
      'agent:leader:team:T',
      'leader',
      '[Task Update] a sub-task finished',
      SYSTEM_TURN,
    )
    await tick()
    const leadCtx = lead.lastStartOpts?.context ?? ''
    expect(leadCtx).toContain('[About the User]')
    expect(leadCtx).toContain('[Leading this team')
  })

  it('splits what is waiting into ADDRESSED and AMBIENT, and marks only what it rendered', async () => {
    // Before the envelope this arrived as two blocks with near-identical headers —
    // `[While you were away, your teammates said]` and `[While you were away]` —
    // and nothing said which of them, or the instruction, the agent was supposed
    // to act on. A peer saying "stop, I already fixed that" read as ignorable.
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team T',
        icon: '🚀',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values([
        { id: 'a1', name: 'Coder', gatewayId: 'a1', teamId: 'T', createdAt: now, updatedAt: now },
        { id: 'a2', name: 'Bug Boo', gatewayId: 'a2', teamId: 'T', createdAt: now, updatedAt: now },
      ])
      .run()
    // Two requests and one FYI, all in the same mailbox.
    const update = enqueueInbox(db, {
      agentId: 'a1',
      teamId: 'T',
      kind: 'task_update',
      body: 'Bug Boo finished: patched auth.ts',
    })
    const alert = enqueueInbox(db, {
      agentId: 'a1',
      teamId: 'T',
      kind: 'alert',
      body: 'Could not deliver a task update to Design Boo',
    })
    const signal = enqueueInbox(db, {
      agentId: 'a1',
      teamId: 'T',
      kind: 'signal',
      body: 'Design Boo started on the schema',
    })
    // And a teammate actually spoke while this agent was idle.
    postToRoom(db, {
      roomId: resolveRoomForTeam('T'),
      teamId: 'T',
      authorAgentId: 'a2',
      body: 'stop, I already fixed that',
      kind: 'peer',
    })

    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
      })(),
    )
    await wire(adapter).deliver(SK, 'a1', 'do the thing', HUMAN_TURN)
    await tick()
    const ctx = adapter.lastStartOpts?.context ?? ''

    const addressedAt = ctx.indexOf('[Addressed to you')
    const ambientAt = ctx.indexOf('[Ambient')
    expect(addressedAt).toBeGreaterThan(-1)
    expect(ambientAt).toBeGreaterThan(addressedAt) // the ask is not buried

    // Requests land in the addressed half…
    const addressedBlock = ctx.slice(addressedAt, ambientAt)
    expect(addressedBlock).toContain('patched auth.ts')
    expect(addressedBlock).toContain('Could not deliver a task update')
    // …and the FYI plus the peer's own words land in the ambient half, with the
    // safety-critical wrapper intact.
    const ambientBlock = ctx.slice(ambientAt)
    expect(ambientBlock).toContain('Design Boo started on the schema')
    expect(ambientBlock).toContain('stop, I already fixed that')
    expect(ambientBlock).toContain('isUser=false')
    expect(ambientBlock).toContain('from=a2')

    // Every row that was rendered is marked — across BOTH sections, from one
    // budget. Splitting the render must not lose half the delivery record.
    // Per-id, so a partial marking cannot hide behind an aggregate: each row we
    // enqueued must be gone from the undelivered set. (The old trailing
    // toHaveLength(3) asserted the length of an array this test built itself,
    // which could never fail.)
    const undelivered = listUndeliveredInbox(db, 'a1', { teamId: 'T' }).map((r) => r.id)
    for (const id of [update.id, alert.id, signal.id]) expect(undelivered).not.toContain(id)
    expect(undelivered).toEqual([])
  })

  it('spends ONE budget across both sections — a section is not a fresh 4000 chars', async () => {
    // Rendering each half against its own ceiling would silently double the cap
    // the mailbox was bounded at, and the digest would start crowding out the
    // instruction it is supposed to accompany.
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team T',
        icon: '🚀',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values([
        { id: 'a1', name: 'Coder', gatewayId: 'a1', teamId: 'T', createdAt: now, updatedAt: now },
      ])
      .run()
    // Twelve requests at the 400-char per-row cap = ~4800 chars of addressed
    // content, which overruns the 4000 budget on its own.
    for (let i = 0; i < 12; i++) {
      enqueueInbox(db, {
        agentId: 'a1',
        teamId: 'T',
        kind: 'task_update',
        body: `u${i} `.padEnd(500, 'x'),
      })
    }
    // At the per-row cap too, so the leftover after the addressed half (4000 minus
    // the nine 404-char lines that fit = 364) cannot hold it. Under a per-section
    // budget it would have had a fresh 4000 and rendered.
    const fyi = enqueueInbox(db, {
      agentId: 'a1',
      teamId: 'T',
      kind: 'signal',
      body: 'a peer FYI that must wait its turn '.padEnd(500, 'z'),
    })

    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
      })(),
    )
    await wire(adapter).deliver(SK, 'a1', 'do the thing', HUMAN_TURN)
    await tick()
    const ctx = adapter.lastStartOpts?.context ?? ''

    // The addressed half ate the budget, so the ambient row was never rendered…
    expect(ctx).not.toContain('a peer FYI that must wait its turn')
    // …and therefore was never marked delivered. It rides the next run.
    expect(listUndeliveredInbox(db, 'a1', { teamId: 'T' }).map((r) => r.id)).toContain(fyi.id)
  })

  it('a QUEUED delivery renders from state at START, not at enqueue time', async () => {
    // `nudge.deliver` FIFO-queues a delivery behind a busy session. The mailbox
    // read, the split/pack, the peer catch-up and the envelope all ran at
    // `deliver()` time, before the queue, so two deliveries stacked on one session
    // both read the SAME undelivered rows and the same cursor: neither had begun.
    // markInboxDelivered stops the double bookkeeping but cannot stop the same
    // context being baked into both runs.
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'T', icon: '🚀', color: '#e94560', createdAt: now, updatedAt: now })
      .run()
    db.insert(agents)
      .values([
        { id: 'a1', name: 'Coder', gatewayId: 'a1', teamId: 'T', createdAt: now, updatedAt: now },
        { id: 'a2', name: 'Bug Boo', gatewayId: 'a2', teamId: 'T', createdAt: now, updatedAt: now },
      ])
      .run()
    enqueueInbox(db, {
      agentId: 'a1',
      teamId: 'T',
      kind: 'task_update',
      body: 'ONLY-ONE-RUN-SHOULD-SEE-THIS',
    })

    const gate = deferred()
    let call = 0
    const adapter = new FakeAdapter((run) => {
      call += 1
      if (call === 1)
        return (async function* () {
          await gate.promise
          yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'one' }
        })()
      return (async function* () {
        yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'two' }
      })()
    })
    const w = wire(adapter)
    // BOTH calls before either closure has marked anything. Awaiting the first
    // would let it mark the row before the second even reads, which hides the bug.
    const p1 = w.deliver(SK, 'a1', 'one', HUMAN_TURN)
    const p2 = w.deliver(SK, 'a1', 'two', HUMAN_TURN) // FIFO-queued behind run 1
    await p1
    gate.resolve()
    for (let i = 0; i < 8; i++) await tick()
    await p2
    for (let i = 0; i < 4; i++) await tick()

    expect(adapter.startOptsLog).toHaveLength(2)
    const seen = adapter.startOptsLog.filter((o) =>
      (o.context ?? '').includes('ONLY-ONE-RUN-SHOULD-SEE-THIS'),
    )
    expect(seen).toHaveLength(1) // exactly one run carries the row, not both
  })

  it('a quiet turn adds NO envelope at all', async () => {
    // The most common case by far. A "(none)" section on every turn would be a
    // permanent tax for the mechanism.
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team T',
        icon: '🚀',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values([
        { id: 'a1', name: 'Coder', gatewayId: 'a1', teamId: 'T', createdAt: now, updatedAt: now },
        { id: 'a2', name: 'Bug Boo', gatewayId: 'a2', teamId: 'T', createdAt: now, updatedAt: now },
      ])
      .run()
    const adapter = new FakeAdapter((run) =>
      (async function* () {
        yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'ok' }
      })(),
    )
    await wire(adapter).deliver(SK, 'a1', 'do the thing', HUMAN_TURN)
    await tick()
    const ctx = adapter.lastStartOpts?.context ?? ''
    expect(ctx).not.toContain('[Ambient')
    expect(ctx).not.toContain('[Addressed to you')
    expect(ctx).toContain('Bug Boo') // the roster still rides it
  })

  it('OpenClaw (connected substrate): a done-with-no-cost estimates spend + tool events hit obs', async () => {
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team T',
        icon: '🚀',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    // A real OpenClaw agent row (runtime openclaw) so the drain tags obs with the
    // runtime AND the connected-mutex key resolves from the row.
    db.insert(agents)
      .values({
        id: 'oc1',
        name: 'OC One',
        gatewayId: 'oc1',
        sourceId: 'openclaw',
        sourceAgentId: 'oc1',
        runtime: 'openclaw',
        teamId: 'T',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    // A generous WARN budget: the estimate is recorded but the run is never paused.
    setBudgetLimit(db, { scope: 'agent', scopeId: 'oc1', limitUsdCents: 1_000_000, mode: 'warn' })

    const connectedCaps: Capabilities = { ...CAPS, runtimeClass: 'connected-substrate' }
    const OC_SK = 'agent:oc1:team:T'
    const bigSummary = 'delivered the task. '.repeat(200) // large so the estimate is unambiguously > 0
    const adapter = new FakeAdapter(
      (run) =>
        (async function* () {
          yield {
            ...base(run.sessionKey, 1),
            kind: 'tool-call',
            toolCallId: 'c1',
            name: 'sessions_send',
            input: { to: '@Coder' },
            partial: false,
          }
          yield {
            ...base(run.sessionKey, 2),
            kind: 'tool-result',
            toolCallId: 'c1',
            name: 'sessions_send',
            output: 'ok',
            isError: false,
          }
          // NO cost event — the connected-substrate fallback estimates on `done`.
          yield { ...base(run.sessionKey, 3), kind: 'done', reason: 'success', summary: bigSummary }
        })(),
      undefined,
      connectedCaps,
    )
    const w = wire(adapter)
    await w.deliver(OC_SK, 'oc1', 'do the thing', HUMAN_TURN)
    for (let i = 0; i < 6; i++) await tick()

    // The terminal-done estimate recorded spend (a connected substrate emits no cost events).
    const budget = getBudget(db, 'agent', 'oc1')
    expect(budget?.spentUsdCents ?? 0).toBeGreaterThan(0)
    // The per-tool detail hit the obs log, tagged with the openclaw runtime.
    const events = listEvents(db, {})
    const kinds = events.map((e) => e.kind)
    expect(kinds).toContain('tool_call')
    expect(kinds).toContain('tool_result')
    expect(events.find((e) => e.kind === 'tool_call')?.runtime).toBe('openclaw')
  })

  describe('run cost on the ledger', () => {
    const DELEGATION = { kind: 'delegation', fromAgentId: 'leader' } as const

    /** A task and its open run, as the engine creates them before it delivers. */
    function seedRun(): { taskId: string; execId: string } {
      const task = createTask(db, { title: 'cost task' })
      const exec = createExecutionProcess(db, { taskId: task.id, executorType: 'openclaw' })
      return { taskId: task.id, execId: exec.id }
    }
    /** The agent's row, so the drain knows the runtime that ran and its model. */
    function seedAgent(runtime: string, execConfig: string | null = null): void {
      const now = Date.now()
      db.insert(teams)
        .values({
          id: 'T',
          name: 'Team T',
          icon: '🚀',
          color: '#e94560',
          createdAt: now,
          updatedAt: now,
        })
        .run()
      db.insert(agents)
        .values({
          id: 'a1',
          name: 'Agent One',
          gatewayId: 'a1',
          sourceId: runtime,
          runtime,
          teamId: 'T',
          execConfig,
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
    const rowOf = (taskId: string) => listExecutions(db, taskId)[0]!
    /** The character estimate the drain prices from what this run was sent. */
    const charEstimate = (adapter: FakeAdapter, model: string | null, outputChars: number) =>
      estimateRunCostUsd({
        model,
        inputChars:
          (adapter.lastStartOpts?.context?.length ?? 0) +
          (adapter.lastStartOpts?.message.length ?? 0),
        outputChars,
      })

    it('a Codex-shaped run records its token estimate, exact tokens and runtime on its own row', async () => {
      seedAgent('codex')
      const { taskId, execId } = seedRun()
      const adapter = new FakeAdapter((run) =>
        (async function* () {
          yield {
            ...base(run.sessionKey, 1),
            kind: 'cost',
            costUsd: null,
            estimated: true,
            usage: { inputTokens: 12_000, outputTokens: 3_000 },
            model: 'gpt-4o',
          }
          yield { ...base(run.sessionKey, 2), kind: 'done', reason: 'success', summary: 'parsed' }
        })(),
      )
      const w = wire(adapter, { taskId, execId })
      await w.deliver(SK, 'a1', 'do the task', DELEGATION)
      for (let i = 0; i < 6; i++) await tick()

      const expected = estimateRunCostUsdFromUsage({
        model: 'gpt-4o',
        inputTokens: 12_000,
        outputTokens: 3_000,
      })
      expect(expected).toBeCloseTo(0.06, 9)
      const row = rowOf(taskId)
      expect(row.costUsd).toBeCloseTo(expected, 12)
      expect(row.costSource).toBe('token-estimate')
      expect(row.inputTokens).toBe(12_000)
      expect(row.outputTokens).toBe(3_000)
      expect(row.runtime).toBe('codex')
      // The engine stub never closes the row: the cost is the drain's own write.
      expect(row.status).toBe('running')
      expect(getTask(db, taskId)!.costUsd).toBeCloseTo(expected, 12)
    })

    it('a fatal error still prices the run: a character estimate on the row and on the budget', async () => {
      setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 1_000_000, mode: 'warn' })
      const { taskId, execId } = seedRun()
      const adapter = new FakeAdapter((run) =>
        (async function* () {
          yield {
            ...base(run.sessionKey, 1),
            kind: 'text-delta',
            text: 'partial',
            channel: 'assistant',
          }
          yield {
            ...base(run.sessionKey, 2),
            kind: 'error',
            code: 'boom',
            message: 'the model crashed',
            fatal: true,
          }
        })(),
      )
      const w = wire(adapter, { taskId, execId })
      await w.deliver(SK, 'a1', 'do the task', DELEGATION)
      for (let i = 0; i < 6; i++) await tick()

      const expected = charEstimate(adapter, null, 'partial'.length)
      expect(expected).toBeGreaterThan(0)
      const row = rowOf(taskId)
      expect(row.costUsd).toBeCloseTo(expected, 12)
      expect(row.costSource).toBe('char-estimate')
      expect(row.inputTokens).toBeNull()
      expect(getTask(db, taskId)!.costUsd).toBeCloseTo(expected, 12)
      expect(getBudget(db, 'agent', 'a1')!.spentMicroCents).toBeGreaterThan(0)
    })

    it('a stream that ends with no terminal is priced before the engine is told it closed', async () => {
      const { taskId, execId } = seedRun()
      const adapter = new FakeAdapter((run) =>
        (async function* () {
          yield {
            ...base(run.sessionKey, 1),
            kind: 'text-delta',
            text: 'half a reply',
            channel: 'assistant',
          }
          // The stream simply ends: no done, no fatal error.
        })(),
      )
      const costAtClose: Array<number | null> = []
      const w = wire(adapter, {
        taskId,
        execId,
        onClose: () => costAtClose.push(rowOf(taskId).costUsd),
      })
      await w.deliver(SK, 'a1', 'do the task', DELEGATION)
      for (let i = 0; i < 6; i++) await tick()

      const expected = charEstimate(adapter, null, 'half a reply'.length)
      expect(w.closed).toEqual([SK])
      expect(costAtClose).toHaveLength(1)
      expect(costAtClose[0]).toBeCloseTo(expected, 12)
      expect(rowOf(taskId).costSource).toBe('char-estimate')
    })

    it("a done with no cost is priced at the agent's configured model", async () => {
      seedAgent('hermes', JSON.stringify({ model: 'claude-opus-4-8', provider: 'anthropic' }))
      const { taskId, execId } = seedRun()
      const summary = 'wrote the report. '.repeat(50)
      const adapter = new FakeAdapter((run) =>
        (async function* () {
          yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary }
        })(),
      )
      const w = wire(adapter, { taskId, execId })
      await w.deliver(SK, 'a1', 'do the task', DELEGATION)
      for (let i = 0; i < 6; i++) await tick()

      const expected = charEstimate(adapter, 'claude-opus-4-8', summary.length)
      // Opus is priced above the default rate, so the model is what moved the number.
      expect(expected).toBeGreaterThan(charEstimate(adapter, null, summary.length))
      const row = rowOf(taskId)
      expect(row.costUsd).toBeCloseTo(expected, 12)
      expect(row.costSource).toBe('char-estimate')
      expect(row.runtime).toBe('hermes')
    })

    it('a reported cost is charged to the budget once, not again at the terminal', async () => {
      setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 1_000_000, mode: 'warn' })
      const { taskId, execId } = seedRun()
      const adapter = new FakeAdapter((run) =>
        (async function* () {
          yield {
            ...base(run.sessionKey, 1),
            kind: 'cost',
            costUsd: 0.25,
            usage: { inputTokens: 100, outputTokens: 20 },
            model: 'claude-haiku-4-5',
          }
          // A done repeats the run's cost (Claude Code) or totals it (native).
          yield {
            ...base(run.sessionKey, 2),
            kind: 'done',
            reason: 'success',
            summary: 'ok',
            costUsd: 0.25,
          }
        })(),
      )
      const w = wire(adapter, { taskId, execId })
      await w.deliver(SK, 'a1', 'do the task', DELEGATION)
      for (let i = 0; i < 6; i++) await tick()

      const row = rowOf(taskId)
      expect(row.costUsd).toBeCloseTo(0.25, 12)
      expect(row.costSource).toBe('reported')
      expect(getBudget(db, 'agent', 'a1')!.spentUsdCents).toBe(25)
    })

    it('a turn that runs no task records nothing, but its estimate still reaches the budget', async () => {
      setBudgetLimit(db, { scope: 'agent', scopeId: 'a1', limitUsdCents: 1_000_000, mode: 'warn' })
      const { taskId, execId } = seedRun()
      const adapter = new FakeAdapter((run) =>
        (async function* () {
          yield { ...base(run.sessionKey, 1), kind: 'done', reason: 'success', summary: 'hello' }
        })(),
      )
      // The engine names a row, but a person's turn is not that task's run.
      const w = wire(adapter, { taskId, execId })
      await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
      for (let i = 0; i < 6; i++) await tick()

      expect(rowOf(taskId).costUsd).toBeNull()
      expect(getBudget(db, 'agent', 'a1')!.spentMicroCents).toBeGreaterThan(0)
    })
  })
})
