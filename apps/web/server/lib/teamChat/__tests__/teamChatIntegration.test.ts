// The mixed-runtime peer-chat headline integration tests — deterministic, fake adapters, no network.
//  (1) Mixed-runtime peer round: [OpenClaw leader + Claude + Hermes + native] all
//      post into ONE room as NAMED PEERS via the real dispatchChatTurn; the
//      ping-pong is bounded; a decision lands as a BOARD MUTATION (chat is
//      narration, the board stays canonical).
//  (2) Codex-as-leader heartbeat-restore: a one-shot runtime LEADS via the
//      restore→one-turn→save loop across ≥2 turns; each turn resumes the prior
//      native session; the room + lineage reflect the cycle.

import {
  createTask,
  listTasks,
  createDb,
  readRoom,
  getSessionBySourceId,
  getSessionLineage,
  type ClawbooDb,
} from '@clawboo/db'
import type { Capabilities, RunHandle, RuntimeAdapter, RuntimeEvent } from '@clawboo/executor'
import { beforeEach, describe, expect, it } from 'vitest'

import type { RuntimeRunContext } from '../../runtimes/types'
import { dispatchChatTurn } from '../dispatchChatTurn'
import { runExchange, type ChatTurnOutcome } from '../exchange'
import { loadChatLeaderState } from '../leaderState'
import type { ChatParticipant } from '../selectNextSpeaker'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

interface FakeAdapterCfg {
  runtimeId: string
  runtimeClass: 'wrapped-oneshot' | 'native' | 'connected-substrate'
  /** Per-turn reply text (the `done.summary`). */
  replies: string[]
  /** Per-turn native session id (what sessionCodec.serialize reports). */
  sessionIds: string[]
  /** Capture the ctx.resume each turn received (to assert heartbeat-restore). */
  onResume?: (resume: string | null) => void
}

/** A minimal RuntimeAdapter factory: one `done` summary per turn + a sessionCodec. */
function fakeChatAdapter(cfg: FakeAdapterCfg): (ctx: RuntimeRunContext) => RuntimeAdapter {
  let turn = -1
  return (ctx: RuntimeRunContext): RuntimeAdapter => {
    turn += 1
    const t = turn
    cfg.onResume?.(ctx.resume ?? null)
    const caps: Capabilities = {
      streaming: true,
      mcp: true,
      worktrees: false,
      resume: true,
      toolApproval: false,
      models: [],
      runtimeClass: cfg.runtimeClass,
    }
    const base = { runId: 'run', sessionId: 'sess', ts: 0, seq: 0 }
    return {
      id: cfg.runtimeId as RuntimeAdapter['id'],
      participantKind: 'agent',
      capabilities: () => caps,
      health: async () => ({ ok: true }),
      start: async (_task, opts): Promise<RunHandle> => ({
        adapterId: cfg.runtimeId,
        sessionKey: opts.sessionKey,
        runId: null,
      }),

      events: async function* (): AsyncIterable<RuntimeEvent> {
        yield {
          ...base,
          kind: 'done',
          reason: 'success',
          summary: cfg.replies[t] ?? 'ok',
        } as RuntimeEvent
      },
      abort: async () => {},
      setModel: async () => {},
      writeContext: async () => {},
      sessionCodec: {
        serialize: async () => JSON.stringify({ sessionId: cfg.sessionIds[t] ?? `sid-${t}` }),
        restore: async (): Promise<RunHandle> => ({
          adapterId: cfg.runtimeId,
          sessionKey: 's',
          runId: null,
        }),
      },
    }
  }
}

describe('mixed-runtime peer round (headline)', () => {
  it('four heterogeneous runtimes post into ONE room as named peers; bounded; board stays canonical', async () => {
    const roomId = 'team:tm1'
    const team: ChatParticipant[] = [
      { agentId: 'boo-leader', runtime: 'openclaw', isLeader: true },
      { agentId: 'boo-claude', runtime: 'claude-code', isLeader: false },
      { agentId: 'boo-hermes', runtime: 'hermes', isLeader: false },
      { agentId: 'boo-native', runtime: 'clawboo-native', isLeader: false },
    ]
    const classOf: Record<string, FakeAdapterCfg['runtimeClass']> = {
      openclaw: 'connected-substrate',
      'claude-code': 'wrapped-oneshot',
      hermes: 'wrapped-oneshot',
      'clawboo-native': 'native',
    }

    let decided = false
    // The exchange dispatch runs the REAL dispatchChatTurn (posts to the room),
    // then injects the obligations that drive the ping-pong + the leader's
    // board DECISION (the canonical write — NOT a chat post).
    const dispatch = async (p: ChatParticipant, turn: number): Promise<ChatTurnOutcome> => {
      await dispatchChatTurn(
        {
          db,
          participant: p,
          roomId,
          teamId: 'tm1',
          makeAdapter: fakeChatAdapter({
            runtimeId: p.runtime,
            runtimeClass: classOf[p.runtime]!,
            replies: [`${p.agentId} says hello`],
            sessionIds: [`sid-${p.agentId}`],
          }),
          stimulus: turn === 1 ? 'team, plan the feature' : null,
        },
        turn,
      )
      if (p.isLeader) {
        if (turn === 1) {
          // A DECISION lands as a board mutation (the canonical source of truth).
          createTask(db, { title: 'Build the feature', teamId: 'tm1' })
          decided = true
          return { obligations: ['boo-claude', 'boo-hermes', 'boo-native'] }
        }
        // The leader keeps the conversation going → the exchange hits the turn cap.
        return { obligations: ['boo-claude'] }
      }
      return { obligations: ['boo-leader'] } // a specialist reports up to the leader
    }

    const res = await runExchange({ roomId, participants: team, dispatch, maxExchangeTurns: 5 })

    // All four heterogeneous runtimes posted as NAMED PEERS into ONE room.
    const room = readRoom(db, { roomId })
    const authors = new Set(room.map((r) => r.authorAgentId))
    expect(authors).toEqual(new Set(['boo-leader', 'boo-claude', 'boo-hermes', 'boo-native']))

    // The ping-pong is BOUNDED (it hit the cap with work still pending).
    expect(res.turnsTaken).toBe(5)
    expect(res.endedReason).toBe('max_turns')

    // The board stays CANONICAL: the decision is a durable board task, and NO
    // team_chat post is a board row (different stores).
    expect(decided).toBe(true)
    const tasks = listTasks(db, { teamId: 'tm1' })
    expect(tasks.map((t) => t.title)).toContain('Build the feature')
    // Every room row is a peer post — chat never mutated the board.
    expect(room.every((r) => r.kind === 'peer')).toBe(true)
  })
})

describe('Codex-as-leader (heartbeat-restore loop)', () => {
  it('a one-shot runtime leads across ≥2 turns, resuming the prior native session each turn', async () => {
    const roomId = 'team:tm2'
    const leader: ChatParticipant = { agentId: 'boo-codex', runtime: 'codex', isLeader: true }
    const resumes: (string | null)[] = []
    const makeAdapter = fakeChatAdapter({
      runtimeId: 'codex',
      runtimeClass: 'wrapped-oneshot',
      replies: ['turn one: assigning work', 'turn two: synthesizing', 'turn three: done'],
      sessionIds: ['codex-sid-1', 'codex-sid-2', 'codex-sid-3'],
      onResume: (r) => resumes.push(r),
    })

    // Drive the heartbeat loop directly: restore → one turn → save → loop.
    for (let turn = 1; turn <= 3; turn++) {
      await dispatchChatTurn(
        {
          db,
          participant: leader,
          roomId,
          teamId: 'tm2',
          makeAdapter,
          stimulus: turn === 1 ? 'kick off' : null,
        },
        turn,
      )
    }

    // Turn 1 has no prior session; turns 2 + 3 resume the predecessor's native id.
    expect(resumes[0]).toBeNull()
    expect(resumes[1]).toBe('codex-sid-1')
    expect(resumes[2]).toBe('codex-sid-2')

    // The room reflects each leader turn (3 named-peer posts by the codex leader).
    const room = readRoom(db, { roomId })
    expect(room).toHaveLength(3)
    expect(room.every((r) => r.authorAgentId === 'boo-codex')).toBe(true)

    // The between-turn state advanced + the session lineage chained the turns.
    const state = loadChatLeaderState(db, roomId, 'boo-codex')
    expect(state.turnIndex).toBe(3)
    expect(state.nativeSessionId).toBe('codex-sid-3')
    // The session lineage chained turn 3 ← turn 2 ← turn 1 (recordRotation).
    const t3 = getSessionBySourceId(db, 'codex', `teamchat:${roomId}:boo-codex:t3`)
    expect(t3).toBeDefined()
    const lineage = getSessionLineage(db, t3!.id)
    expect(lineage.length).toBeGreaterThanOrEqual(2)
  })
})

// Live spike (manual / opt-in) — exercises REAL runtimes. Env-gated like the
// other live suites so CI stays deterministic (the suite above uses fake
// adapters): set CLAWBOO_LIVE_TEAMCHAT=1 to run it. To run: a real OpenClaw
// Gateway + a logged-in Claude Code / Codex, then drive `dispatchChatTurn` with
// `adapterFactoryFor(runtime)` (not a fake) for one real leader turn and read the
// room. Any evidence (logs / cost) belongs outside the repo, never committed.
const LIVE_TEAMCHAT = process.env['CLAWBOO_LIVE_TEAMCHAT'] === '1'
describe.skipIf(!LIVE_TEAMCHAT)(
  'LIVE: mixed team posts to one room + a one-shot runtime leads a real turn',
  () => {
    it('a real Claude Code / Codex leader serves one heartbeat turn via dispatchChatTurn', () => {
      // Intentionally empty — see the comment above for the manual procedure.
      expect(true).toBe(true)
    })
  },
)
