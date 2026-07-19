// THE integration gate for "a Codex agent can LEAD a team" (the ChatGPT-subscription
// team). Wires the REAL engine (createBoardOrchestrator) + the REAL run primitive
// (createServerDeliver) + the REAL board (createServerBoardClient over real sqlite)
// exactly as teamOrchestrator's buildInstance does, with FAKE codex-shaped adapters
// injected via the makeAdapterForAgent seam (no subprocess, no network).
//
// Proves the full chain the feature rests on:
//   leader tool-call named `clawboo-teamchat.team_delegate` (the MCP-NAMESPACED name
//   a real Codex run emits — exercising the engine's name-keyed DELEGATE_TOOL_NAME_RE
//   tolerance, not the bare name)
//   → extractSignals → board task create + claim → delivery to the codex WORKER
//   → worker `done` → task `done` + report-up comment
//   → `[Task Update]` reflection re-delivered to the LEADER (after REFLECT_WINDOW_MS)
//   → the leader's SYNTHESIS turn is chat-persisted, while its delegation-ack turn is
//     SUPPRESSED (delegatedThisTurn — the runtime-agnostic ack suppression).
//
// In this Boo-Zero-less install (no native member/key, no OpenClaw default) the
// leader resolves via `booZeroForTeam` → null → `team.leaderAgentId` — the exact
// resolution a pure-Codex (subscription-only) install relies on.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agents,
  createDb,
  getComments,
  getSetting,
  listTasks,
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
import {
  agentIdFromSessionKey,
  buildTeamSessionKey,
  createBoardOrchestrator,
  createNudgeQueue,
  REFLECT_WINDOW_MS,
  type BoardOrchestrator,
} from '@clawboo/team-orchestration'

import { getDbPath } from '../../db'
import { booZeroForTeam } from '../booZero'
import { nativeTeamSessionSettingKey } from '../nativeTeamSession'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'

const TEAM = 'T'
const LEAD = 'codex-lead'
const WORKER = 'codex-worker'
const skFor = (id: string): string => buildTeamSessionKey(id, TEAM)!

const CODEX_CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
  runtimeClass: 'wrapped-oneshot',
  // Persistent per-identity home — what makes a leader turn pointer-eligible
  // (teamResumeEligible needs a persistent homeDir), matching the real adapter.
  nativeHome: { scope: 'per-identity', persist: true },
}

type Script = RuntimeEvent[]

/** A codex-shaped scripted adapter: each start() consumes the agent's next script.
 *  Carries a sessionCodec (like the real CodexAdapter) reporting a per-turn sid, so
 *  the drain's leader-pointer write is exercised. */
class ScriptedCodex implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'codex'
  readonly startOpts: StartOpts[] = []
  private turn = 0
  constructor(private readonly scripts: Script[]) {}
  capabilities(): Capabilities {
    return CODEX_CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startOpts.push(opts)
    this.turn += 1
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  readonly sessionCodec = {
    serialize: async (run: RunHandle): Promise<string> =>
      JSON.stringify({ sessionKey: run.sessionKey, sessionId: `codex-sid-${this.turn}` }),
    restore: async (): Promise<RunHandle> => ({ adapterId: this.id, sessionKey: '', runId: null }),
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const script = this.scripts.shift() ?? []
    const sk = run.sessionKey
    return (async function* () {
      let seq = 0
      for (const ev of script) {
        seq += 1
        yield { ...ev, runId: sk, sessionId: sk, ts: seq, seq } as RuntimeEvent
      }
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

const done = (summary: string): RuntimeEvent =>
  ({ kind: 'done', reason: 'success', summary }) as RuntimeEvent

/** Advance fake time in small steps (interleaving REAL macrotasks — fs I/O in the
 *  drains isn't timer-gated) until `until()` holds or the fake-time budget runs out.
 *  The cascade mixes timer-gated stages (the 3s reflect batch) with real-I/O stages
 *  (mkdir, sqlite), so under full-suite load on a slow CI runner the drains' I/O lags
 *  the fake-time advance. A single setImmediate per step and a tight budget let the
 *  cascade stall after the worker completes but before the leader's synthesis turn is
 *  delivered (leadStarts=1 not 2). Fix: a generous budget PLUS several real macrotask
 *  turns per step so the I/O keeps pace; the loop still exits the instant `until()`
 *  flips, so the fast (local) path is unchanged. */
async function settle(until: () => boolean, budgetMs = 30 * REFLECT_WINDOW_MS): Promise<void> {
  const step = 250
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  }
  for (let t = 0; t < budgetMs && !until(); t += step) {
    await vi.advanceTimersByTimeAsync(step)
    await flush() // real macrotask flushes (I/O completions)
  }
  await flush() // let any last real I/O settle before the caller asserts
}

describe('Codex-led cascade (delegate MCP tool → board → report-up → synthesis)', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    // Fake ONLY the timer functions the cascade's batching rides on — setImmediate
    // and friends stay REAL so the drains' genuine fs/sqlite I/O can complete
    // between fake-time steps (see `settle`).
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-codex-lead-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = createDb(getDbPath())
    const now = Date.now()
    db.insert(teams)
      .values({
        id: TEAM,
        name: 'Sub Team',
        icon: '🚀',
        color: '#e94560',
        leaderAgentId: LEAD,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values([
        {
          id: LEAD,
          name: 'Codex Lead',
          gatewayId: LEAD,
          sourceId: 'codex',
          runtime: 'codex',
          teamId: TEAM,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: WORKER,
          name: 'Codex Worker',
          gatewayId: WORKER,
          sourceId: 'codex',
          runtime: 'codex',
          teamId: TEAM,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run()
  })
  afterEach(async () => {
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  it('a subscription-only (Boo-Zero-less) install resolves the codex leader via team.leaderAgentId', () => {
    // No native member/key + no teamless OpenClaw default → no universal Boo Zero:
    // the resolution a pure-Codex install rests on falls to `team.leaderAgentId`.
    expect(booZeroForTeam(db, TEAM)).toBeNull()
  })

  it('leader team_delegate tool-call → board task → worker → report-up → leader synthesis', async () => {
    const persisted: Array<{ sk: string; text: string }> = []
    const abortMap = new Map<string, RunEntry>()
    const nudge = createNudgeQueue()

    // Per-agent scripts. The leader's SECOND script is its reflection/synthesis turn.
    const adapters = new Map<string, ScriptedCodex>([
      [
        LEAD,
        new ScriptedCodex([
          [
            {
              kind: 'tool-call',
              // The MCP-NAMESPACED name a real Codex run emits for the TeamChat
              // server's tool — must trip the engine's DELEGATE_TOOL_NAME_RE.
              name: 'clawboo-teamchat.team_delegate',
              input: { assignee: 'Codex Worker', task: 'write the CSV parser' },
              partial: false,
            } as unknown as RuntimeEvent,
            done('handed off to the worker'), // the premature ack — must be SUPPRESSED
          ],
          [done('SYNTHESIS: the CSV parser is written and tested')],
        ]),
      ],
      [WORKER, new ScriptedCodex([[done('parser written: src/parser.ts, 12 tests green')]])],
    ])

    const engineRef: { current: BoardOrchestrator | null } = { current: null }
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      nudge,
      abortMap,
      onEvent: (sk, ev) => engineRef.current!.onEvent(sk, ev),
      onSessionClosed: (sk) => engineRef.current!.onSessionClosed(sk),
      taskForSession: (sk) => engineRef.current!.taskForSession(sk),
      persistTurn: (sk, text) => persisted.push({ sk, text }),
      makeAdapterForAgent: (agentId) => adapters.get(agentId) ?? null,
    })
    const engine = createBoardOrchestrator({
      teamId: TEAM,
      board: createServerBoardClient(db),
      known: () => [
        { id: LEAD, name: 'Codex Lead' },
        { id: WORKER, name: 'Codex Worker' },
      ],
      leaderAgentId: () => LEAD,
      sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
      agentIdForSession: (sk) => agentIdFromSessionKey(sk),
      deliver,
      stopGen: () => 0,
      caps: { maxFanout: 8 },
    })
    engineRef.current = engine

    // The user's turn reaches the leader (what enqueueUserMessage does post-resolution).
    await deliver(skFor(LEAD), LEAD, 'team: build a CSV parser')

    // Settle the whole cascade: leader drain → spawn → worker drain → report-up →
    // the 3s reflect batch → the leader's synthesis turn persisting to chat.
    await settle(() => persisted.length >= 1)

    // 1. The delegation became a DURABLE board task, ran on the worker, and is DONE.
    const tasks = listTasks(db, { teamId: TEAM })
    expect(tasks).toHaveLength(1)
    const task = tasks[0]!
    expect(task.status).toBe('done')
    expect(task.assigneeAgentId).toBe(WORKER)
    expect(`${task.title} ${task.description ?? ''}`).toContain('CSV parser')

    // 2. The worker's result reached the board as the report-up comment.
    const comments = getComments(db, task.id).map((c) => c.body)
    expect(comments.join('\n')).toContain('parser written: src/parser.ts')

    // 3. The worker actually RAN via the deliver primitive (its script consumed).
    expect(adapters.get(WORKER)!.startOpts).toHaveLength(1)
    expect(adapters.get(WORKER)!.startOpts[0]!.message).toContain('write the CSV parser')

    // 4. The leader ran TWICE: the user turn, then the [Task Update] reflection turn.
    const leadStarts = adapters.get(LEAD)!.startOpts
    expect(leadStarts).toHaveLength(2)
    expect(leadStarts[1]!.message).toContain('[Task Update]')

    // 5. Chat cleanliness: the leader's delegation-ACK turn was SUPPRESSED
    //    (delegatedThisTurn — the runtime-agnostic DELEGATE_TOOL_RE), and the
    //    worker's task turn never persists to chat — ONLY the synthesis lands.
    expect(persisted).toHaveLength(1)
    expect(persisted[0]!.sk).toBe(skFor(LEAD))
    expect(persisted[0]!.text).toContain('SYNTHESIS')
    expect(persisted.map((p) => p.text).join('\n')).not.toContain('handed off')

    // 6. Leader CONTINUITY: the pointer holds the LAST leader turn's native thread
    //    id (turn 2 = the synthesis run), written via the adapter's sessionCodec —
    //    the next user message resumes it (`codex exec resume <sid>`). The WORKER,
    //    a delegated child, never writes a pointer (its continuity is the handoff).
    expect(getSetting(db, nativeTeamSessionSettingKey(LEAD, TEAM))).toBe('codex-sid-2')
    expect(getSetting(db, nativeTeamSessionSettingKey(WORKER, TEAM)) || null).toBeNull()
  })

  it('stale-pointer self-heal: a FAILED resumed leader turn clears the pointer', async () => {
    // A dead handle (e.g. the managed home's sessions were wiped): `codex exec
    // resume <unknown-id>` hard-fails. Without the clear, EVERY subsequent turn
    // re-reads the same pointer and loops through identical failures.
    setSetting(db, nativeTeamSessionSettingKey(LEAD, TEAM), 'stale-sid')

    const adapters = new Map<string, ScriptedCodex>([
      [
        LEAD,
        new ScriptedCodex([
          [{ kind: 'done', reason: 'error', summary: 'session not found' } as RuntimeEvent],
        ]),
      ],
    ])
    const engineRef: { current: BoardOrchestrator | null } = { current: null }
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      nudge: createNudgeQueue(),
      abortMap: new Map<string, RunEntry>(),
      onEvent: (sk, ev) => engineRef.current!.onEvent(sk, ev),
      onSessionClosed: (sk) => engineRef.current!.onSessionClosed(sk),
      taskForSession: (sk) => engineRef.current!.taskForSession(sk),
      makeAdapterForAgent: (agentId) => adapters.get(agentId) ?? null,
    })
    engineRef.current = createBoardOrchestrator({
      teamId: TEAM,
      board: createServerBoardClient(db),
      known: () => [{ id: LEAD, name: 'Codex Lead' }],
      leaderAgentId: () => LEAD,
      sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
      agentIdForSession: (sk) => agentIdFromSessionKey(sk),
      deliver,
      stopGen: () => 0,
    })

    await deliver(skFor(LEAD), LEAD, 'follow-up message')
    await settle(() => !getSetting(db, nativeTeamSessionSettingKey(LEAD, TEAM)))

    // The failed resumed turn CLEARED the pointer — the next turn starts fresh
    // instead of resuming the dead handle again.
    expect(getSetting(db, nativeTeamSessionSettingKey(LEAD, TEAM)) || null).toBeNull()
  })
})
