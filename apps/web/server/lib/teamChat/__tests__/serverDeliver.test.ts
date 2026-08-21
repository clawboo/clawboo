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

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agents,
  enqueueInbox,
  getBudget,
  listEvents,
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
import { createNudgeQueue, type NudgeQueue } from '@clawboo/team-orchestration'

import { getDb, resetDb } from '../../db'
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

const SK = 'agent:a1:team:T'

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}
const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))

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
    },
  ) {
    let doneGateUsed = false
    const order: string[] = []
    const events: RuntimeEvent[] = []
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
      drain: () => real.drain(),
      reset: () => real.reset(),
    }
    const deliver = createServerDeliver({
      db,
      teamId: 'T',
      mcpBaseUrl: null,
      nudge,
      abortMap,
      onEvent: async (_sk, e) => {
        order.push(`event:${e.kind}`)
        events.push(e)
        if (e.kind === 'done' && opts?.firstDoneGate && !doneGateUsed) {
          doneGateUsed = true
          await opts.firstDoneGate
        }
      },
      onSessionClosed: async (sk) => {
        closed.push(sk)
      },
      taskForSession: () => opts?.taskId ?? null,
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
    return { deliver, order, events, closed, persisted, metas, deltas, statuses, abortMap }
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
    await w.deliver(SK, 'a1', 'hi', HUMAN_TURN)
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
    // The dead stream never commits — the client's StreamingCard is cleared (the
    // empty-text sentinel) and the badge flips back to idle.
    expect(w.deltas.at(-1)?.text).toBe('')
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
})
