// dispatchChatTurn — abort safety. A turn aborted in-flight (a client disconnect)
// must commit NO durable state: no room post, no leader-state advance, no rotation
// lineage, no spend. Mirrors the executor releasing a task on abort rather than
// persisting partial work. Drives the REAL dispatchChatTurn (not the loop-level fake
// dispatch the exchange tests use), covering exchange-safety-001/002/004.

import {
  createDb,
  getBudget,
  readRoom,
  resolveRoomForTeam,
  setBudgetLimit,
  type ClawbooDb,
} from '@clawboo/db'
import type { RunHandle, RuntimeAdapter, RuntimeEvent } from '@clawboo/executor'
import { beforeEach, describe, expect, it } from 'vitest'

import type { RuntimeRunContext } from '../../runtimes/types'
import { dispatchChatTurn } from '../dispatchChatTurn'
import { loadChatLeaderState } from '../leaderState'
import type { ChatParticipant } from '../selectNextSpeaker'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const participant: ChatParticipant = { agentId: 'cc', runtime: 'clawboo-native', isLeader: true }

/** An adapter whose stream emits a costly `done`. `onEvents` fires the moment the
 *  adapter is drained — a test uses it to abort the signal mid-turn. */
function adapterFactory(opts: {
  onEvents?: () => void
  costUsd?: number
  /** The turn's terminal text. Defaults to ordinary prose. */
  summary?: string
}): (ctx: RuntimeRunContext) => RuntimeAdapter {
  const base = { runId: 'run', sessionId: 'sess', ts: 0, seq: 0 }
  return (): RuntimeAdapter => ({
    id: 'clawboo-native',
    participantKind: 'agent',
    capabilities: () => ({
      streaming: true,
      mcp: true,
      worktrees: false,
      resume: true,
      toolApproval: false,
      models: [],
      runtimeClass: 'native',
    }),
    health: async () => ({ ok: true }),
    start: async (_t, o): Promise<RunHandle> => ({
      adapterId: 'clawboo-native',
      sessionKey: o.sessionKey,
      runId: null,
    }),
    events: async function* (): AsyncIterable<RuntimeEvent> {
      opts.onEvents?.() // a test can abort here to simulate a mid-stream disconnect
      yield {
        ...base,
        kind: 'done',
        reason: 'success',
        summary: opts.summary ?? 'partial answer',
        ...(opts.costUsd != null ? { costUsd: opts.costUsd } : {}),
      } as RuntimeEvent
    },
    abort: async () => {},
    setModel: async () => {},
    writeContext: async () => {},
    dispose: async () => {},
  })
}

function assertNoCommit(teamId: string, roomId: string): void {
  expect(readRoom(db, { roomId })).toHaveLength(0) // no durable peer post
  expect(loadChatLeaderState(db, roomId, participant.agentId).turnIndex).toBe(0) // no leader-state advance
  expect(getBudget(db, 'team', teamId)?.spentUsdCents ?? 0).toBe(0) // no spend
}

describe('dispatchChatTurn — an aborted turn commits no durable state', () => {
  it('a pre-aborted signal short-circuits before draining (no post / no leader-state / no spend)', async () => {
    const teamId = 'tA'
    const roomId = resolveRoomForTeam(teamId)
    setBudgetLimit(db, { scope: 'team', scopeId: teamId, limitUsdCents: 1000, mode: 'cap' })
    const controller = new AbortController()
    controller.abort()

    const out = await dispatchChatTurn(
      {
        db,
        participant,
        roomId,
        teamId,
        makeAdapter: adapterFactory({ costUsd: 0.05 }),
        signal: controller.signal,
      },
      1,
    )

    expect(out.obligations).toEqual([])
    assertNoCommit(teamId, roomId)
  })

  it('an abort DURING the turn short-circuits after draining (no post / no leader-state / no spend)', async () => {
    const teamId = 'tB'
    const roomId = resolveRoomForTeam(teamId)
    setBudgetLimit(db, { scope: 'team', scopeId: teamId, limitUsdCents: 1000, mode: 'cap' })
    const controller = new AbortController()

    const out = await dispatchChatTurn(
      {
        db,
        participant,
        roomId,
        teamId,
        makeAdapter: adapterFactory({ onEvents: () => controller.abort(), costUsd: 0.05 }),
        signal: controller.signal,
      },
      1,
    )

    expect(out.obligations).toEqual([])
    assertNoCommit(teamId, roomId)
  })

  it('WITHOUT an abort, the same turn DOES commit (post + leader-state + spend) — the guard is abort-specific', async () => {
    const teamId = 'tC'
    const roomId = resolveRoomForTeam(teamId)
    setBudgetLimit(db, { scope: 'team', scopeId: teamId, limitUsdCents: 1000, mode: 'cap' })

    await dispatchChatTurn(
      { db, participant, roomId, teamId, makeAdapter: adapterFactory({ costUsd: 0.05 }) },
      1,
    )

    expect(readRoom(db, { roomId })).toHaveLength(1)
    expect(loadChatLeaderState(db, roomId, participant.agentId).turnIndex).toBe(1)
    expect(getBudget(db, 'team', teamId)?.spentUsdCents ?? 0).toBeGreaterThan(0)
  })
})

describe('dispatchChatTurn: a connector ask never leaks its marker', () => {
  it('a reply that is ONLY a marker posts no peer message, and the marker never becomes context', async () => {
    // The failure this pins: `body: ask.body || terminal` fell back to the raw
    // text, so a marker-only turn put `[[connect:linear]]` in the room as the
    // agent's answer AND saved it as `lastSummary`, where the next turn reads a
    // control token as prose to imitate.
    const teamId = 'tMarker'
    const roomId = resolveRoomForTeam(teamId)
    setBudgetLimit(db, { scope: 'team', scopeId: teamId, limitUsdCents: 1000, mode: 'cap' })

    await dispatchChatTurn(
      {
        db,
        participant,
        roomId,
        teamId,
        makeAdapter: adapterFactory({ summary: '[[connect:linear]]' }),
      },
      1,
    )

    expect(readRoom(db, { roomId })).toHaveLength(0)
    const state = loadChatLeaderState(db, roomId, participant.agentId)
    expect(state.lastSummary ?? '').not.toContain('[[connect:')
    expect(state.lastSummary ?? '').toBe('')
  })

  it('a reply with prose AND a marker posts the prose alone, marker stripped', async () => {
    const teamId = 'tMixed'
    const roomId = resolveRoomForTeam(teamId)
    setBudgetLimit(db, { scope: 'team', scopeId: teamId, limitUsdCents: 1000, mode: 'cap' })

    await dispatchChatTurn(
      {
        db,
        participant,
        roomId,
        teamId,
        makeAdapter: adapterFactory({
          summary: 'I need Linear to read that issue.\n[[connect:linear]]',
        }),
      },
      1,
    )

    const posts = readRoom(db, { roomId })
    expect(posts).toHaveLength(1)
    expect(posts[0]!.body).toBe('I need Linear to read that issue.')
    expect(posts[0]!.body).not.toContain('[[connect:')
    expect(loadChatLeaderState(db, roomId, participant.agentId).lastSummary).not.toContain(
      '[[connect:',
    )
  })
})
