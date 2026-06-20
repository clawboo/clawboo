// runTeamExchange — the production trigger for the peer-chat engine. Drives a
// REAL exchange (real runExchange + dispatchChatTurn + emit→obs against a real
// DB) with deterministic injected adapters at the leaf. Proves:
//  (001) the engine runs through the trigger AND the obs log records
//        speaker_selected + turn_bound_hit;
//  (002) OpenClaw's room post carries the AUTHORITATIVE bound author (server-
//        mediated — not model-controlled), so a peer can't spoof another author;
//  (004) the capability-driven construction branch fails CLOSED for a
//        connected-substrate participant with no operator client (skipped);
//  (005) normalizeSingleLeader collapses a two-leader team to one + warns.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  createDb,
  getBudget,
  listEvents,
  readRoom,
  recordSpend,
  resolveRoomForTeam,
  setBudgetLimit,
  teams,
  type ClawbooDb,
} from '@clawboo/db'
import {
  ClaudeCodeAdapter,
  type ClaudeCodeDriver,
  type ClaudeNativeEvent,
} from '@clawboo/adapter-claude-code'
import { CodexAdapter, type CodexDriver, type CodexNativeEvent } from '@clawboo/adapter-codex'
import { NativeAdapter, type NativeDriver, type NativeEvent } from '@clawboo/adapter-native'
import type { Capabilities, RunHandle, RuntimeAdapter, RuntimeEvent } from '@clawboo/executor'
import { usdToFractionalCents } from '@clawboo/governance'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { runtimeIdentityHomePath } from '../../runtimes/identityHome'
import type { RuntimeRunContext } from '../../runtimes/types'
import { normalizeSingleLeader, runTeamExchange } from '../runTeamExchange'
import type { ChatParticipant } from '../selectNextSpeaker'

let db: ClawbooDb
let homeDir: string
let prevHome: string | undefined
beforeEach(() => {
  db = createDb(':memory:')
  // Sandbox CLAWBOO_HOME so a persistent runtime's per-identity home mkdir lands in
  // a temp dir, never the real ~/.clawboo.
  homeDir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-tx-'))
  prevHome = process.env['CLAWBOO_HOME']
  process.env['CLAWBOO_HOME'] = homeDir
})
afterEach(() => {
  if (prevHome === undefined) delete process.env['CLAWBOO_HOME']
  else process.env['CLAWBOO_HOME'] = prevHome
  rmSync(homeDir, { recursive: true, force: true })
})

function seedTeam(
  teamId: string,
  members: Array<{ id: string; runtime: string }>,
  leaderId: string | null,
): void {
  const now = Date.now()
  db.insert(teams)
    .values({
      id: teamId,
      name: 'T',
      icon: '🤖',
      color: '#000',
      leaderAgentId: leaderId,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  for (const m of members) {
    db.insert(agents)
      .values({
        id: m.id,
        name: m.id,
        gatewayId: m.id,
        runtime: m.runtime,
        sourceId: m.runtime,
        teamId,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  }
}

/** A construction-count-INDEPENDENT fake: every construction returns an adapter
 *  that emits one fixed `done` summary (a probe construction is harmless). */
function fixedAdapter(
  runtimeId: string,
  runtimeClass: Capabilities['runtimeClass'],
  reply: string,
): (ctx: RuntimeRunContext) => RuntimeAdapter {
  const caps: Capabilities = {
    streaming: true,
    mcp: true,
    worktrees: false,
    resume: true,
    toolApproval: false,
    models: [],
    runtimeClass,
  }
  const base = { runId: 'run', sessionId: 'sess', ts: 0, seq: 0 }
  return (): RuntimeAdapter => ({
    id: runtimeId as RuntimeAdapter['id'],
    participantKind: 'agent',
    capabilities: () => caps,
    health: async () => ({ ok: true }),
    start: async (_task, opts): Promise<RunHandle> => ({
      adapterId: runtimeId,
      sessionKey: opts.sessionKey,
      runId: null,
    }),

    events: async function* (): AsyncIterable<RuntimeEvent> {
      yield { ...base, kind: 'done', reason: 'success', summary: reply } as RuntimeEvent
    },
    abort: async () => {},
    setModel: async () => {},
    writeContext: async () => {},
  })
}

/** Like fixedAdapter but the `done` carries a reported `costUsd` (a runtime that
 *  reports real spend), so a budget test is deterministic. */
function costAdapter(
  runtimeId: string,
  runtimeClass: Capabilities['runtimeClass'],
  reply: string,
  costUsd: number,
): (ctx: RuntimeRunContext) => RuntimeAdapter {
  const caps: Capabilities = {
    streaming: true,
    mcp: true,
    worktrees: false,
    resume: true,
    toolApproval: false,
    models: [],
    runtimeClass,
  }
  const base = { runId: 'run', sessionId: 'sess', ts: 0, seq: 0 }
  return (): RuntimeAdapter => ({
    id: runtimeId as RuntimeAdapter['id'],
    participantKind: 'agent',
    capabilities: () => caps,
    health: async () => ({ ok: true }),
    start: async (_task, opts): Promise<RunHandle> => ({
      adapterId: runtimeId,
      sessionKey: opts.sessionKey,
      runId: null,
    }),

    events: async function* (): AsyncIterable<RuntimeEvent> {
      yield { ...base, kind: 'done', reason: 'success', summary: reply, costUsd } as RuntimeEvent
    },
    abort: async () => {},
    setModel: async () => {},
    writeContext: async () => {},
  })
}

/** A CodexDriver double that REPLAYS its native events the moment the adapter
 *  subscribes, so the REAL CodexAdapter mapper produces the `done` (with usage but
 *  NO USD — Codex's real shape). This drives the REAL adapter, NOT an injected
 *  RuntimeEvent with a hand-set costUsd. Mirrors executorRunner.test.ts. */
class ReplayCodexDriver implements CodexDriver {
  constructor(private readonly events: CodexNativeEvent[]) {}
  async start(): Promise<void> {}
  onEvent(handler: (ev: CodexNativeEvent) => void): () => void {
    for (const ev of this.events) handler(ev)
    return () => {}
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

/** Same replay-on-subscribe double for Claude Code — its REAL `result` frame maps
 *  to BOTH a `cost` event AND a `done` event carrying the same run total, so a turn
 *  driven through the REAL ClaudeCodeAdapter exercises the double-count path that a
 *  hand-rolled fake (one `done.costUsd`) never hits. */
class ReplayClaudeDriver implements ClaudeCodeDriver {
  constructor(private readonly events: ClaudeNativeEvent[]) {}
  async start(): Promise<void> {}
  onEvent(handler: (ev: ClaudeNativeEvent) => void): () => void {
    for (const ev of this.events) handler(ev)
    return () => {}
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

/** Same double for the native runtime — its `turn` frames map to per-turn `cost`
 *  DELTAS and the `result` maps to a run-CUMULATIVE `done.costUsd`, so summing both
 *  would double-bill. Driving the REAL NativeAdapter proves the fix on that shape. */
class ReplayNativeDriver implements NativeDriver {
  constructor(private readonly events: NativeEvent[]) {}
  async start(): Promise<void> {}
  onEvent(handler: (ev: NativeEvent) => void): () => void {
    for (const ev of this.events) handler(ev)
    return () => {}
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

describe('runTeamExchange (the production trigger)', () => {
  it('drives a mixed-runtime exchange through the trigger; obs records speaker_selected + turn_bound_hit; OpenClaw posts with the bound author', async () => {
    seedTeam(
      'tm1',
      [
        { id: 'boo-leader', runtime: 'openclaw' },
        { id: 'boo-native', runtime: 'clawboo-native' },
      ],
      'boo-leader',
    )

    const adapters: Record<string, (ctx: RuntimeRunContext) => RuntimeAdapter> = {
      'boo-leader': fixedAdapter('openclaw', 'connected-substrate', 'leader: here is the plan'),
      'boo-native': fixedAdapter('clawboo-native', 'native', 'native: on it'),
    }

    const res = await runTeamExchange({
      db,
      teamId: 'tm1',
      stimulus: 'team, plan the feature',
      firstSpeakers: ['boo-leader', 'boo-native'], // both seeded → a 2-turn round
      makeAdapterFor: (p) => adapters[p.agentId] ?? null,
    })

    expect(res.ok).toBe(true)
    expect(res.result?.turnsTaken).toBe(2)

    // Both heterogeneous runtimes posted as named peers into the ONE room.
    const room = readRoom(db, { roomId: resolveRoomForTeam('tm1') })
    expect(new Set(room.map((r) => r.authorAgentId))).toEqual(new Set(['boo-leader', 'boo-native']))
    // 002 anti-spoof: the OpenClaw post's author is the AUTHORITATIVE bound id
    // (the participant the server drove) — never a model-supplied author.
    const openclawPost = room.find((r) => r.body.includes('here is the plan'))
    expect(openclawPost?.authorAgentId).toBe('boo-leader')

    // 001: the lifecycle was projected into the obs log.
    expect(listEvents(db, { kinds: ['speaker_selected'] })).toHaveLength(2)
    const bound = listEvents(db, { kinds: ['turn_bound_hit'] })
    expect(bound).toHaveLength(1)
    expect((bound[0]!.data ? JSON.parse(bound[0]!.data) : {}).reason).toBe('no_pending_obligation')
  })

  it('fails CLOSED (capability-driven): a connected-substrate participant with no operator client is skipped — no post, no crash', async () => {
    seedTeam('tm2', [{ id: 'boo-oc', runtime: 'openclaw' }], 'boo-oc')
    // Default adapter construction + a null operator client → the OpenClaw
    // participant can't be built, so it's dropped from the exchange.
    const res = await runTeamExchange({ db, teamId: 'tm2', getOperatorClient: () => null })
    expect(res.ok).toBe(true)
    // The leader was selected (a turn was taken) but produced no room post.
    expect(readRoom(db, { roomId: resolveRoomForTeam('tm2') })).toHaveLength(0)
    expect(listEvents(db, { kinds: ['speaker_selected'] }).length).toBeGreaterThanOrEqual(1)
  })

  it('returns 404-shaped error for an unknown team and "no agents" for an empty team', async () => {
    expect((await runTeamExchange({ db, teamId: 'ghost' })).error).toBe('team not found')
    db.insert(teams)
      .values({
        id: 'tm3',
        name: 'T',
        icon: '🤖',
        color: '#000',
        createdAt: Date.now(),
        updatedAt: Date.now(),
      })
      .run()
    expect((await runTeamExchange({ db, teamId: 'tm3' })).error).toBe('team has no agents')
  })

  it('PRE-FLIGHT refuses the whole exchange when the team CAP budget is already paused', async () => {
    seedTeam('tmg', [{ id: 'a', runtime: 'clawboo-native' }], 'a')
    setBudgetLimit(db, { scope: 'team', scopeId: 'tmg', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'team', 'tmg', 150) // blow the cap → paused
    expect(getBudget(db, 'team', 'tmg')?.status).toBe('paused')

    const res = await runTeamExchange({
      db,
      teamId: 'tmg',
      makeAdapterFor: (p) => costAdapter(p.runtime, 'native', 'x', 0.01),
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('budget_paused')
    // No turns ran — nothing was posted to the room.
    expect(readRoom(db, { roomId: resolveRoomForTeam('tmg') })).toHaveLength(0)
  })

  it("PRE-FLIGHT refuses the exchange when a NON-LEADER first-speaker's agent CAP budget is paused (cost-002)", async () => {
    // The leader's budget is fine, but a seeded specialist's agent CAP is already
    // paused. Pre-flight must refuse the whole exchange up front — NOT dispatch one
    // billed turn before the reactive halt. Before the fix only the leader was gated.
    seedTeam(
      'tmfs',
      [
        { id: 'lead', runtime: 'clawboo-native' },
        { id: 'spec', runtime: 'clawboo-native' },
      ],
      'lead',
    )
    setBudgetLimit(db, { scope: 'agent', scopeId: 'spec', limitUsdCents: 100, mode: 'cap' })
    recordSpend(db, 'agent', 'spec', 150) // blow the specialist's cap → paused
    expect(getBudget(db, 'agent', 'spec')?.status).toBe('paused')

    const res = await runTeamExchange({
      db,
      teamId: 'tmfs',
      firstSpeakers: ['lead', 'spec'],
      makeAdapterFor: (p) => costAdapter(p.runtime, 'native', 'x', 0.01),
    })
    expect(res.ok).toBe(false)
    expect(res.error).toBe('budget_paused:agent')
    // The paused specialist was refused before any dispatch — no room post.
    expect(readRoom(db, { roomId: resolveRoomForTeam('tmfs') })).toHaveLength(0)
  })

  it('records per-turn spend and STOPS the exchange when a turn trips the team cap', async () => {
    seedTeam(
      'tms',
      [
        { id: 'a', runtime: 'clawboo-native' },
        { id: 'b', runtime: 'clawboo-native' },
      ],
      'a',
    )
    setBudgetLimit(db, { scope: 'team', scopeId: 'tms', limitUsdCents: 3, mode: 'cap' })

    const res = await runTeamExchange({
      db,
      teamId: 'tms',
      firstSpeakers: ['a', 'b'], // would be a 2-turn round
      makeAdapterFor: (p) => costAdapter(p.runtime, 'native', `${p.agentId} ok`, 0.05), // 5¢ each
    })
    expect(res.ok).toBe(true)
    // The first turn's 5¢ blew through the 3¢ cap → the exchange halted.
    expect(res.result?.endedReason).toBe('budget_paused')
    expect(res.result?.turnsTaken).toBe(1)
    expect(getBudget(db, 'team', 'tms')?.status).toBe('paused')
  })

  it('estimates a REAL Codex turn (reports usage, NO costUsd) so the team cap engages + the exchange halts — real adapter, not a fake', async () => {
    // The central-lesson guard: a turn whose budget proof comes from a REAL adapter,
    // not a hand-rolled fake that injects `costUsd`. Codex reports token `usage` but
    // emits `costUsd: null` by design, so `drainTurn` sees no real cost (sawCost=false)
    // and the exchange must ESTIMATE the spend from the produced text. The cap must
    // still engage — proving the no-cost path is wired, not just the reports-cost path.
    seedTeam(
      'tmcx',
      [
        { id: 'cx', runtime: 'codex' },
        { id: 'cx2', runtime: 'codex' },
      ],
      'cx',
    )
    setBudgetLimit(db, { scope: 'team', scopeId: 'tmcx', limitUsdCents: 1, mode: 'cap' })

    const res = await runTeamExchange({
      db,
      teamId: 'tmcx',
      firstSpeakers: ['cx', 'cx2'], // a 2-turn round; the first turn's estimate trips the cap
      makeAdapterFor: () => () =>
        new CodexAdapter(
          () =>
            new ReplayCodexDriver([
              {
                type: 'result',
                ok: true,
                summary: 'x'.repeat(8000), // a non-trivial reply → a cap-engaging char estimate
                usage: { inputTokens: 100_000, outputTokens: 100_000 },
                model: 'gpt-5-codex',
              },
            ]),
        ),
    })

    expect(res.ok).toBe(true)
    // The estimated spend on the REAL null-cost turn blew the 1¢ cap → the exchange halted.
    expect(res.result?.endedReason).toBe('budget_paused')
    expect(res.result?.turnsTaken).toBe(1)
    const b = getBudget(db, 'team', 'tmcx')
    expect(b?.status).toBe('paused') // the cap engaged from the ESTIMATE, not an injected cost
    expect(b?.spentUsdCents ?? 0).toBeGreaterThan(0) // real-adapter spend is no longer invisible
  })

  it('records a REAL Claude Code turn 1× — not 2× — even though its `result` carries cost on BOTH the cost AND done event', async () => {
    // cost-001 (real shape): Claude Code's single `result` frame maps to a `cost`
    // event AND a `done` event that BOTH carry the same run total. Driving the REAL
    // ClaudeCodeAdapter proves `drainTurn` records the turn ONCE ($0.05 → 5¢), not
    // twice (10¢). A fake that emits only `done.costUsd` (the prior coverage) never
    // hits this path, which is exactly why CI was green on the bug. The 8¢ cap would
    // falsely pause on a doubled 10¢ spend.
    const oneXCents = Math.floor(usdToFractionalCents(0.05)) // $0.05 → 5 fractional cents
    seedTeam('tmcc', [{ id: 'cc', runtime: 'claude-code' }], 'cc')
    setBudgetLimit(db, { scope: 'team', scopeId: 'tmcc', limitUsdCents: 8, mode: 'cap' })

    const res = await runTeamExchange({
      db,
      teamId: 'tmcc',
      firstSpeakers: ['cc'],
      makeAdapterFor: () => () =>
        new ClaudeCodeAdapter(
          () =>
            new ReplayClaudeDriver([
              {
                type: 'result',
                ok: true,
                summary: 'claude: done',
                costUsd: 0.05, // emitted on BOTH the cost AND the done event
                usage: { inputTokens: 1000, outputTokens: 1000 },
                model: 'claude-haiku-4-5',
              },
            ]),
        ),
    })

    expect(res.ok).toBe(true)
    expect(res.result?.turnsTaken).toBe(1)
    const b = getBudget(db, 'team', 'tmcc')
    expect(b?.spentUsdCents).toBe(oneXCents) // 5, not 10 — `done.costUsd` did not re-bill
    expect(b?.status).not.toBe('paused') // 1× (5) is under the 8¢ cap; 2× (10) would have paused
  })

  it('records a REAL native turn 1× — not 2× — even though `turn` is a cost DELTA and `done` is the run CUMULATIVE', async () => {
    // cost-001 (native shape): a `turn` frame maps to a per-turn `cost` DELTA and the
    // `result` maps to a run-CUMULATIVE `done.costUsd`. drainTurn must not sum
    // delta+cumulative. Driving the REAL NativeAdapter proves the fix on that shape.
    const oneXCents = Math.floor(usdToFractionalCents(0.05))
    seedTeam('tmnv', [{ id: 'nv', runtime: 'clawboo-native' }], 'nv')
    setBudgetLimit(db, { scope: 'team', scopeId: 'tmnv', limitUsdCents: 8, mode: 'cap' })

    const res = await runTeamExchange({
      db,
      teamId: 'tmnv',
      firstSpeakers: ['nv'],
      makeAdapterFor: () => () =>
        new NativeAdapter(
          () =>
            new ReplayNativeDriver([
              {
                type: 'turn',
                usage: { inputTokens: 1000, outputTokens: 1000 },
                costUsd: 0.05,
                model: 'claude-haiku-4-5',
              },
              {
                type: 'result',
                ok: true,
                summary: 'native: done',
                usage: { inputTokens: 1000, outputTokens: 1000 },
                costUsd: 0.05, // the run CUMULATIVE — the deltas already sum to it
              },
            ]),
        ),
    })

    expect(res.ok).toBe(true)
    expect(res.result?.turnsTaken).toBe(1)
    const b = getBudget(db, 'team', 'tmnv')
    expect(b?.spentUsdCents).toBe(oneXCents) // 5 (Σdeltas), not 10 (Σdeltas + cumulative)
    expect(b?.status).not.toBe('paused')
  })

  it('clamps an over-large maxExchangeTurns to a server-side ceiling', async () => {
    seedTeam(
      'tmc',
      [
        { id: 'a', runtime: 'clawboo-native' },
        { id: 'b', runtime: 'clawboo-native' },
      ],
      'a',
    )
    const res = await runTeamExchange({
      db,
      teamId: 'tmc',
      maxExchangeTurns: 9999,
      firstSpeakers: ['a'],
      makeAdapterFor: (p) => fixedAdapter(p.runtime, 'native', `${p.agentId} ok`),
    })
    expect(res.ok).toBe(true)
    const bound = listEvents(db, { kinds: ['turn_bound_hit'] })
    const data = JSON.parse(bound[0]!.data!) as { maxExchangeTurns: number }
    expect(data.maxExchangeTurns).toBe(5 * 2) // DEFAULT_MAX_EXCHANGE_TURNS × participants, not 9999
  })

  it('refuses a firstSpeaker that is not a team member (no silent ignore)', async () => {
    seedTeam('tmf', [{ id: 'a', runtime: 'clawboo-native' }], 'a')
    const res = await runTeamExchange({
      db,
      teamId: 'tmf',
      firstSpeakers: ['a', 'ghost'],
      makeAdapterFor: (p) => fixedAdapter(p.runtime, 'native', 'x'),
    })
    expect(res.ok).toBe(false)
    expect(res.error).toContain('unknown first speaker')
  })

  it('a persistent runtime reuses its stable per-identity home (not a throwaway)', async () => {
    seedTeam('tmh', [{ id: 'boo-native', runtime: 'clawboo-native' }], 'boo-native')
    let capturedHome: string | null | undefined
    const capturing = (ctx: RuntimeRunContext): RuntimeAdapter => {
      capturedHome = ctx.homeDir
      const caps: Capabilities = {
        streaming: true,
        mcp: true,
        worktrees: false,
        resume: true,
        toolApproval: false,
        models: [],
        runtimeClass: 'native',
        // A persistent per-identity home is what makes runTeamExchange materialize
        // ctx.homeDir + serialize via the mutex (mirrors the real native adapter).
        nativeHome: { scope: 'per-identity', persist: true },
      }
      const base = { runId: 'run', sessionId: 'sess', ts: 0, seq: 0 }
      return {
        id: 'clawboo-native',
        participantKind: 'agent',
        capabilities: () => caps,
        health: async () => ({ ok: true }),
        start: async (_t, opts): Promise<RunHandle> => ({
          adapterId: 'clawboo-native',
          sessionKey: opts.sessionKey,
          runId: null,
        }),

        events: async function* (): AsyncIterable<RuntimeEvent> {
          yield { ...base, kind: 'done', reason: 'success', summary: 'ok' } as RuntimeEvent
        },
        abort: async () => {},
        setModel: async () => {},
        writeContext: async () => {},
      }
    }
    const res = await runTeamExchange({
      db,
      teamId: 'tmh',
      firstSpeakers: ['boo-native'],
      makeAdapterFor: () => capturing,
    })
    expect(res.ok).toBe(true)
    // The turn ran against the stable per-identity home (serialized via the shared
    // home mutex), not a throwaway — so the runtime's native state compounds.
    expect(capturedHome).toBe(runtimeIdentityHomePath('clawboo-native', 'boo-native'))
  })

  it('serializes two concurrent CONNECTED OpenClaw chat turns on ONE agent through the shared per-agent mutex (cross-path with routines)', async () => {
    // Cross-path mutex: a connected (homeDir-less) OpenClaw turn must serialize on the
    // SAME mutex the routine dispatcher uses, so a chat turn + a
    // routine fire (or two chat turns) never open overlapping Gateway sessions on one
    // physical agent. Two concurrent exchanges on the same agent must run SEQUENTIALLY.
    seedTeam('tmlock', [{ id: 'oc', runtime: 'openclaw' }], 'oc')
    const CONNECTED_CAPS: Capabilities = {
      streaming: true,
      mcp: true,
      worktrees: false,
      resume: true,
      toolApproval: false,
      models: [],
      runtimeClass: 'connected-substrate',
    }
    const base = { runId: 'run', sessionId: 'sess', ts: 0, seq: 0 }
    const order: string[] = []
    let releaseFirst!: () => void
    const firstGate = new Promise<void>((r) => {
      releaseFirst = r
    })
    const gatedAdapter = (label: string, gate: Promise<void> | null) => (): RuntimeAdapter => ({
      id: 'openclaw',
      participantKind: 'agent',
      capabilities: () => CONNECTED_CAPS,
      health: async () => ({ ok: true }),
      start: async (_t, opts): Promise<RunHandle> => {
        order.push(`start:${label}`)
        return { adapterId: 'openclaw', sessionKey: opts.sessionKey, runId: null }
      },
      events: async function* (): AsyncIterable<RuntimeEvent> {
        if (gate) await gate // A holds the mutex here while B is launched
        order.push(`done:${label}`)
        yield { ...base, kind: 'done', reason: 'success', summary: label } as RuntimeEvent
      },
      abort: async () => {},
      setModel: async () => {},
      writeContext: async () => {},
    })

    const p1 = runTeamExchange({
      db,
      teamId: 'tmlock',
      firstSpeakers: ['oc'],
      makeAdapterFor: () => gatedAdapter('A', firstGate),
    })
    // Wait until A has acquired the mutex + started (then it blocks on its gate).
    while (!order.includes('start:A')) await new Promise((r) => setImmediate(r))
    const p2 = runTeamExchange({
      db,
      teamId: 'tmlock',
      firstSpeakers: ['oc'],
      makeAdapterFor: () => gatedAdapter('B', null),
    })
    // Give B time to reach the mutex; it must BLOCK (A still holds it).
    await new Promise((r) => setTimeout(r, 30))
    expect(order).toEqual(['start:A']) // B did NOT start — serialized behind A

    releaseFirst()
    await Promise.all([p1, p2])
    // A fully completed before B started → one session at a time on the agent.
    expect(order).toEqual(['start:A', 'done:A', 'start:B', 'done:B'])
  })
})

describe('normalizeSingleLeader (split-brain guard)', () => {
  it('keeps the first leader, demotes the rest, and warns when >1 is flagged', () => {
    const warns: Array<{ obj: Record<string, unknown>; msg: string }> = []
    const log = { warn: (obj: Record<string, unknown>, msg: string) => warns.push({ obj, msg }) }
    const participants: ChatParticipant[] = [
      { agentId: 'a', runtime: 'clawboo-native', isLeader: true },
      { agentId: 'b', runtime: 'openclaw', isLeader: true },
      { agentId: 'c', runtime: 'hermes', isLeader: false },
    ]
    const out = normalizeSingleLeader(participants, log)
    expect(out.filter((p) => p.isLeader).map((p) => p.agentId)).toEqual(['a'])
    expect(warns).toHaveLength(1)
    expect(warns[0]!.msg).toContain('multiple leaders')
  })

  it('is a no-op (no warn) for a single-leader or leaderless team', () => {
    const warns: string[] = []
    const log = { warn: (_o: Record<string, unknown>, m: string) => warns.push(m) }
    const one: ChatParticipant[] = [
      { agentId: 'a', runtime: 'clawboo-native', isLeader: true },
      { agentId: 'b', runtime: 'openclaw', isLeader: false },
    ]
    expect(normalizeSingleLeader(one, log)).toBe(one)
    expect(warns).toHaveLength(0)
  })
})
