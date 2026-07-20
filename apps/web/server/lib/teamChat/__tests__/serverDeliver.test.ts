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
  createDb,
  getBudget,
  listEvents,
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

import { getDbPath } from '../../db'
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
    db = createDb(getDbPath())
  })
  afterEach(async () => {
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
      persistTurn: (sk, text) => {
        persisted.push({ sk, text })
        // Default (undefined) counts as persisted — the legacy-stub contract; an
        // explicit false simulates a write-time drop / insert error.
        return opts?.persistReturns
      },
      publishDelta: (sk, runId, text) => deltas.push({ sk, runId, text }),
      publishStatus: (agentId, status) => statuses.push({ agentId, status }),
      makeAdapterForAgent: () => adapter,
    })
    return { deliver, order, events, closed, persisted, deltas, statuses, abortMap }
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

    await w.deliver(SK, 'a1', 'hello')
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
    await w.deliver(SK, 'a1', 'write a poem')
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
    await w.deliver(SK, 'leader', 'ask 2 teammates for a poem')
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
    await leader.deliver(SK, 'a1', 'hello')
    for (let i = 0; i < 4; i++) await tick()
    expect(leader.statuses).toEqual([
      { agentId: 'a1', status: 'running' },
      { agentId: 'a1', status: 'idle' },
    ])
    // Delegated child: chat-invisible, but the left-pane badge still tracks it.
    const child = wire(mk(), { taskId: 'task-1' })
    await child.deliver(SK, 'a1', 'subtask')
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
    await w.deliver(SK, 'a1', 'hi')
    for (let i = 0; i < 4; i++) await tick()
    // What the user watched streaming survives the failure as a committed turn…
    expect(w.persisted).toEqual([{ sk: SK, text: 'partial answer' }])
    // …and the badge flips to error, not a silent stuck-Working.
    expect(w.statuses.at(-1)).toEqual({ agentId: 'a1', status: 'error' })
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
    await w.deliver(SK, 'a1', 'hi')
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
    await w.deliver(SK, 'a1', 'hi')
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
    await w.deliver(SK, 'a1', 'hi')
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

    await w.deliver(SK, 'a1', 'one') // run 1 in flight (nudge marked the session busy)
    const p2 = w.deliver(SK, 'a1', 'two') // queued behind run 1
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
    await expect(w.deliver(SK, 'a1', 'hi')).rejects.toThrow('boom')
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
    await w.deliver(SK, 'a1', 'hi')
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
    await w.deliver(SK, 'a1', 'poem')
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
    await w.deliver(SK, 'a1', 'spendy')
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
    await w.deliver(SK, 'a1', 'do the thing') // SK = agent:a1:team:T (recipient a1)
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
    await w.deliver(SK, 'a1', 'do the thing')
    await tick()
    const ctx = adapter.lastStartOpts?.context ?? ''
    expect(ctx).toContain('[Team Rules — set by the user, authoritative]')
    expect(ctx).toContain('Always answer in French')
    expect(ctx).toContain('[About the User]')
    expect(ctx).toContain('I am a PM')
    expect(ctx).toContain('Coder') // roster still present
    expect(ctx).not.toContain('Team Lead') // recipient still excluded
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
    await w.deliver(OC_SK, 'oc1', 'do the thing')
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
