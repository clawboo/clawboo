// Chat rooms and the run primitive.
//
// Each chat room has its own orchestrator, so its own serverDeliver, nudge queue
// and abort map. Two things must hold across them anyway:
//   1. An agent active in two rooms never runs two turns at once on its one
//      home. Nothing per-room arbitrates that; the process-wide home mutex does,
//      and this pins it.
//   2. A room's turn is told about the room's members only, so the lead cannot
//      hand work to a teammate outside the room.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { agents, createRoom, teams, type ClawbooDb } from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  TaskHandle,
} from '@clawboo/executor'
import { buildTeamSessionKey, createNudgeQueue, HUMAN_TURN } from '@clawboo/team-orchestration'

import { getDb, resetDb } from '../../db'
import { createServerDeliver, type RunEntry } from '../serverDeliver'

const PERSISTENT_CAPS: Capabilities = {
  streaming: true,
  mcp: false,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
  nativeHome: { scope: 'per-identity', persist: true },
}

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 0))
async function settle(n = 6): Promise<void> {
  for (let i = 0; i < n; i++) await tick()
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** One adapter shared by both rooms (the same agent): each run waits on its own
 *  gate before its terminal, and the adapter records how many runs are live. */
class GatedAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'fake-native'
  live = 0
  maxLive = 0
  starts: StartOpts[] = []
  private gates: Array<{ promise: Promise<void>; resolve: () => void }> = []
  capabilities(): Capabilities {
    return PERSISTENT_CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.starts.push(opts)
    this.live += 1
    this.maxLive = Math.max(this.maxLive, this.live)
    // The run stops counting as live the moment its gate opens.
    const gate = deferred()
    this.gates.push({
      promise: gate.promise.then(() => {
        this.live -= 1
      }),
      resolve: gate.resolve,
    })
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const gate = this.gates[this.gates.length - 1]!
    return (async function* () {
      await gate.promise
      yield {
        runId: run.sessionKey,
        sessionId: run.sessionKey,
        ts: 1,
        seq: 1,
        kind: 'done',
        reason: 'success',
        summary: 'ok',
      } satisfies RuntimeEvent
    })()
  }
  finishRun(i: number): void {
    this.gates[i]!.resolve()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

describe('serverDeliver across chat rooms', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb
  let roomId: string

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-deliver-rooms-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: 'T',
        name: 'Team',
        icon: 'T',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    for (const [id, name] of [
      ['a1', 'Ada'],
      ['a2', 'Bea'],
      ['a3', 'Cy'],
    ] as const) {
      db.insert(agents)
        .values({
          id,
          name,
          gatewayId: id,
          sourceId: 'clawboo-native',
          runtime: 'clawboo-native',
          teamId: 'T',
          createdAt: now,
          updatedAt: now,
        })
        .run()
    }
    roomId = createRoom(db, { teamId: 'T', name: 'Design', memberIds: ['a1', 'a2'] }).id
  })

  afterEach(async () => {
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  function room(chatRoomId: string | null, adapter: RuntimeAdapter) {
    const abortMap = new Map<string, RunEntry>()
    return createServerDeliver({
      db,
      teamId: 'T',
      chatRoomId,
      mcpBaseUrl: null,
      nudge: createNudgeQueue(),
      abortMap,
      onEvent: async () => undefined,
      onSessionClosed: async () => undefined,
      taskForSession: () => null,
      execForSession: () => null,
      stopGen: () => 0,
      leaderAgentId: () => 'a1',
      makeAdapterForAgent: () => adapter,
    })
  }

  it('one agent in two rooms runs one turn at a time on its home', async () => {
    const adapter = new GatedAdapter()
    const team = room(null, adapter)
    const design = room(roomId, adapter)

    // Both rooms address Ada at once.
    void team(buildTeamSessionKey('a1', 'T'), 'a1', 'from the team chat', HUMAN_TURN)
    void design(buildTeamSessionKey('a1', 'T', roomId), 'a1', 'from the room', HUMAN_TURN)
    await settle()
    // Only one run started: the second waits on the same home lock.
    expect(adapter.starts).toHaveLength(1)

    adapter.finishRun(0)
    await settle()
    expect(adapter.starts).toHaveLength(2)
    expect(adapter.maxLive).toBe(1)
    // Each run went out on its own room's session key.
    expect(adapter.starts.map((s) => s.sessionKey).sort()).toEqual(
      [buildTeamSessionKey('a1', 'T'), buildTeamSessionKey('a1', 'T', roomId)].sort(),
    )
    adapter.finishRun(1)
    await settle()
  })

  it("a room's turn lists only the room's members as teammates", async () => {
    const adapter = new GatedAdapter()
    const design = room(roomId, adapter)
    void design(buildTeamSessionKey('a1', 'T', roomId), 'a1', 'plan it', HUMAN_TURN)
    await settle()
    const roomContext = adapter.starts[0]?.context ?? ''
    expect(roomContext).toContain('Bea')
    expect(roomContext).not.toContain('Cy')
    adapter.finishRun(0)
    await settle()

    // The team's own group chat still lists everyone.
    const team = room(null, adapter)
    void team(buildTeamSessionKey('a1', 'T'), 'a1', 'plan it', HUMAN_TURN)
    await settle()
    const teamContext = adapter.starts[1]?.context ?? ''
    expect(teamContext).toContain('Bea')
    expect(teamContext).toContain('Cy')
    adapter.finishRun(1)
    await settle()
  })
})
