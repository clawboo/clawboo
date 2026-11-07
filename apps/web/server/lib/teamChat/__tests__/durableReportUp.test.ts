// The lead's `[Task Update]` survives a server restart. Wires the REAL engine,
// the REAL run primitive (createServerDeliver), the REAL board and the REAL
// report-up outbox over one temp SQLite file, exactly as teamOrchestrator's
// buildInstance does, with scripted adapters injected through the
// makeAdapterForAgent seam. A "process" is one engine + deliver + nudge queue;
// a restart drops it with its timers and builds the next one over the same
// database, which is all that outlives a real restart.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agents,
  createRoom,
  listPendingReportUps,
  recordReportUp,
  settleReportUps,
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
  HUMAN_TURN,
  REFLECT_WINDOW_MS,
  type BoardOrchestrator,
  type RunStamp,
  type TurnOrigin,
} from '@clawboo/team-orchestration'

import { getDb, getDbPath, resetDb } from '../../db'
import { createReportUpOutbox } from '../reportUpOutbox'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'
import {
  getTeamOrchestrator,
  resetTeamOrchestrators,
  retireRoomOrchestrator,
  roomsWithUnheldReportUps,
  writeTeamAlert,
} from '../teamOrchestrator'

const TEAM = 'T'
const LEAD = 'lead'
const WORKER = 'worker'
const skFor = (id: string): string => buildTeamSessionKey(id, TEAM)!

// No persistent home: a run that hangs must not hold the per-identity home
// mutex into the next "process" (a real restart takes the mutex with it).
const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: false,
  toolApproval: true,
  models: [],
  runtimeClass: 'wrapped-oneshot',
}

/** `hang` is a run that started and never ends: the server dies mid-run. */
type Script = RuntimeEvent[] | 'hang'

class ScriptedAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'codex'
  readonly startOpts: StartOpts[] = []
  constructor(private readonly scripts: Script[]) {}
  capabilities(): Capabilities {
    return CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startOpts.push(opts)
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const script = this.scripts.shift() ?? []
    const sk = run.sessionKey
    return (async function* () {
      if (script === 'hang') {
        await new Promise<never>(() => undefined)
        return
      }
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

const delegateCall = (task: string): RuntimeEvent =>
  ({
    kind: 'tool-call',
    name: 'clawboo-teamchat.team_delegate',
    input: { assignee: 'Worker', task },
    partial: false,
  }) as unknown as RuntimeEvent

async function settle(until: () => boolean, budgetMs = 30 * REFLECT_WINDOW_MS): Promise<void> {
  const flush = async (): Promise<void> => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setImmediate(r))
  }
  for (let t = 0; t < budgetMs && !until(); t += 250) {
    await vi.advanceTimersByTimeAsync(250)
    await flush()
  }
  await flush()
}

/** One server process's team chat engine for the default room. */
function bootProcess(
  db: ClawbooDb,
  adapters: Map<string, ScriptedAdapter>,
): { engine: BoardOrchestrator; deliver: ReturnType<typeof createServerDeliver> } {
  const engineRef: { current: BoardOrchestrator | null } = { current: null }
  const abortMap = new Map<string, RunEntry>()
  const deliver = createServerDeliver({
    db,
    teamId: TEAM,
    mcpBaseUrl: null,
    nudge: createNudgeQueue(),
    abortMap,
    onEvent: (sk, ev, run) => engineRef.current!.onEvent(sk, ev, run),
    onSessionClosed: (sk, run) => engineRef.current!.onSessionClosed(sk, run),
    onRunNotStarted: (run) => engineRef.current!.onRunNotStarted(run),
    taskForSession: (sk) => engineRef.current!.taskForSession(sk),
    execForSession: (sk) => engineRef.current!.execForSession(sk),
    stopGen: () => 0,
    leaderAgentId: () => LEAD,
    persistTurn: () => undefined,
    makeAdapterForAgent: (agentId) => adapters.get(agentId) ?? null,
  })
  const engine = createBoardOrchestrator({
    teamId: TEAM,
    board: createServerBoardClient(db),
    known: () => [
      { id: LEAD, name: 'Lead' },
      { id: WORKER, name: 'Worker' },
    ],
    leaderAgentId: () => LEAD,
    sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
    agentIdForSession: (sk) => agentIdFromSessionKey(sk),
    deliver,
    stopGen: () => 0,
    isSessionBusy: (sk) => abortMap.has(sk),
    reportUps: createReportUpOutbox(db, TEAM, null),
  })
  engineRef.current = engine
  return { engine, deliver }
}

const updatesTo = (a: ScriptedAdapter): StartOpts[] =>
  a.startOpts.filter((o) => o.message.startsWith('[Task Update]'))

describe('durable report-up across a server restart', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-report-up-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: TEAM,
        name: 'Team',
        icon: '🚀',
        color: '#e94560',
        leaderAgentId: LEAD,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values(
        [LEAD, WORKER].map((id) => ({
          id,
          name: id === LEAD ? 'Lead' : 'Worker',
          gatewayId: id,
          sourceId: 'codex',
          runtime: 'codex',
          teamId: TEAM,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run()
  })
  afterEach(async () => {
    resetTeamOrchestrators()
    resetDb()
    vi.clearAllTimers()
    vi.useRealTimers()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  it('a lead that died mid-synthesis hears the result once after the restart, then never again', async () => {
    // Process 1: the lead hands off, the worker finishes, and the server dies
    // while the lead's `[Task Update]` run is still going.
    const lead1 = new ScriptedAdapter([
      [delegateCall('write the CSV parser'), done('handed off')],
      'hang',
    ])
    const worker1 = new ScriptedAdapter([[done('parser written: src/parser.ts, 12 tests green')]])
    const first = bootProcess(
      db,
      new Map([
        [LEAD, lead1],
        [WORKER, worker1],
      ]),
    )
    await first.deliver(skFor(LEAD), LEAD, 'team: build a CSV parser', HUMAN_TURN)
    await settle(() => updatesTo(lead1).length >= 1)
    expect(updatesTo(lead1)).toHaveLength(1)
    expect(updatesTo(lead1)[0]!.message).toContain('parser written')
    vi.clearAllTimers() // the process dies

    // Process 2: the room's engine is rebuilt and resumes.
    const lead2 = new ScriptedAdapter([[done('SYNTHESIS: the parser is in')]])
    const second = bootProcess(db, new Map([[LEAD, lead2]]))
    await second.engine.resume()
    await settle(
      () => updatesTo(lead2).length >= 1 && listPendingReportUps(db, TEAM, null).length === 0,
    )
    expect(updatesTo(lead2)).toHaveLength(1)
    expect(updatesTo(lead2)[0]!.message).toContain('parser written')
    expect(listPendingReportUps(db, TEAM, null)).toHaveLength(0)
    vi.clearAllTimers()

    // Process 3: nothing is pending, so nothing is sent.
    const lead3 = new ScriptedAdapter([[done('should not run')]])
    const third = bootProcess(db, new Map([[LEAD, lead3]]))
    await third.engine.resume()
    await settle(() => false, 4 * REFLECT_WINDOW_MS)
    expect(lead3.startOpts).toHaveLength(0)
  })
})

/** An adapter whose runs never start. */
class FailingStart extends ScriptedAdapter {
  override async start(): Promise<RunHandle> {
    throw new Error('spawn failed')
  }
}

describe('a delivery carrying report-ups that never starts', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-report-up-start-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
  })
  afterEach(async () => {
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  function deliverWith(
    notStarted: RunStamp[],
    makeAdapter: () => RuntimeAdapter = () => new FailingStart([]),
  ): {
    deliver: ReturnType<typeof createServerDeliver>
    nudge: ReturnType<typeof createNudgeQueue>
  } {
    const nudge = createNudgeQueue()
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      nudge,
      abortMap: new Map<string, RunEntry>(),
      onEvent: async () => undefined,
      onSessionClosed: async () => undefined,
      onRunNotStarted: (run) => notStarted.push(run),
      taskForSession: () => null,
      execForSession: () => null,
      stopGen: () => 0,
      leaderAgentId: () => LEAD,
      persistTurn: () => undefined,
      makeAdapterForAgent: makeAdapter,
    })
    return { deliver, nudge }
  }

  const update: TurnOrigin = { kind: 'system', reportUpIds: ['ru-1'] }

  it('hands its report-ups back to the engine when it had waited in the queue', async () => {
    const notStarted: RunStamp[] = []
    const { deliver, nudge } = deliverWith(notStarted)
    nudge.markBusy(skFor(LEAD)) // the lead is mid-run
    await deliver(skFor(LEAD), LEAD, '[Task Update] done', update)
    expect(notStarted).toEqual([])

    nudge.markIdle(skFor(LEAD)) // its run ends; the queued update tries to start
    for (let i = 0; i < 20 && notStarted.length === 0; i++)
      await new Promise((r) => setImmediate(r))

    expect(notStarted).toEqual([
      { deliveryId: expect.any(String), reportForTaskId: null, stopGen: 0, reportUpIds: ['ru-1'] },
    ])
  })

  it('hands them back too when setting up the queued run throws before it starts', async () => {
    const notStarted: RunStamp[] = []
    const { deliver, nudge } = deliverWith(notStarted, () => {
      throw new Error('could not build the adapter')
    })
    nudge.markBusy(skFor(LEAD))
    await deliver(skFor(LEAD), LEAD, '[Task Update] done', update)

    nudge.markIdle(skFor(LEAD))
    for (let i = 0; i < 20 && notStarted.length === 0; i++)
      await new Promise((r) => setImmediate(r))

    expect(notStarted).toEqual([
      { deliveryId: expect.any(String), reportForTaskId: null, stopGen: 0, reportUpIds: ['ru-1'] },
    ])
  })

  it("leaves a start that fails at once to the engine's own retry", async () => {
    const notStarted: RunStamp[] = []
    const { deliver } = deliverWith(notStarted)
    await expect(deliver(skFor(LEAD), LEAD, '[Task Update] done', update)).rejects.toThrow(
      'spawn failed',
    )
    expect(notStarted).toEqual([])
  })
})

describe('the report-up outbox', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-report-up-store-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: TEAM,
        name: 'Team',
        icon: '🚀',
        color: '#e94560',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })
  afterEach(async () => {
    resetTeamOrchestrators()
    resetDb()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  it('keeps each room apart and lets the first settlement win', () => {
    const general = createReportUpOutbox(db, TEAM, null)
    const room = createReportUpOutbox(db, TEAM, 'room-1')
    const a = general.record({ toAgentId: null, by: 'Worker', summary: 'done A', taskId: 't-a' })!
    const b = room.record({ toAgentId: 'x', by: 'Worker', summary: 'done B' })!

    expect(general.pending().map((r) => r.id)).toEqual([a])
    expect(room.pending().map((r) => r.id)).toEqual([b])
    expect(general.pending()[0]!.item).toEqual({
      toAgentId: null,
      by: 'Worker',
      summary: 'done A',
      taskId: 't-a',
    })

    general.markReplayed([a])
    general.markReplayed([a])
    expect(general.pending()[0]!.replays).toBe(2)

    general.settle([a], 'stopped')
    general.settle([a], 'delivered')
    expect(general.pending()).toEqual([])
    expect(settleReportUps(db, [a], 'gave_up')).toEqual([])
  })

  it('drops an unreadable row instead of waking its room forever', () => {
    recordReportUp(db, {
      teamId: TEAM,
      roomId: null,
      recipientAgentId: null,
      taskId: null,
      payload: '{"by": 3}',
    })
    expect(createReportUpOutbox(db, TEAM, null).pending()).toEqual([])
    expect(listPendingReportUps(db, TEAM, null)).toEqual([])
  })

  it('the boot scan wakes a room only while no resident engine holds its report-ups', () => {
    createReportUpOutbox(db, TEAM, null).record({ toAgentId: null, by: 'W', summary: 's' })
    recordReportUp(db, {
      teamId: 'gone-team',
      roomId: null,
      recipientAgentId: null,
      taskId: null,
      payload: '{}',
    })

    expect(roomsWithUnheldReportUps(db)).toEqual([{ teamId: TEAM, roomId: null }])
    // The orphaned team's row was reaped.
    expect(listPendingReportUps(db, 'gone-team', null)).toEqual([])

    getTeamOrchestrator(TEAM)
    expect(roomsWithUnheldReportUps(db)).toEqual([])
  })

  it('archiving a room closes an update a Stop held too: no run of its recipient will come', async () => {
    const room = createRoom(db, { teamId: TEAM, name: 'Held', memberIds: [] })
    const outbox = createReportUpOutbox(db, TEAM, room.id)
    const held = outbox.record({ toAgentId: null, by: 'W', summary: 's' }, { held: true })!
    expect(outbox.held().map((r) => r.id)).toEqual([held])
    await retireRoomOrchestrator(TEAM, room.id)
    expect(outbox.held()).toEqual([])
    expect(settleReportUps(db, [held], 'delivered')).toEqual([])
  })

  it('archiving a room drops its updates as stopped, whether or not its engine is loaded', async () => {
    const loaded = createRoom(db, { teamId: TEAM, name: 'Loaded', memberIds: [] })
    const idle = createRoom(db, { teamId: TEAM, name: 'Idle', memberIds: [] })
    const a = createReportUpOutbox(db, TEAM, loaded.id).record({
      toAgentId: null,
      by: 'W',
      summary: 's',
    })!
    const b = createReportUpOutbox(db, TEAM, idle.id).record({
      toAgentId: null,
      by: 'W',
      summary: 's',
    })!
    const general = createReportUpOutbox(db, TEAM, null).record({
      toAgentId: null,
      by: 'W',
      summary: 's',
    })!
    getTeamOrchestrator(TEAM, { roomId: loaded.id })

    await retireRoomOrchestrator(TEAM, loaded.id)
    await retireRoomOrchestrator(TEAM, idle.id)

    expect(listPendingReportUps(db, TEAM, loaded.id)).toEqual([])
    expect(listPendingReportUps(db, TEAM, idle.id)).toEqual([])
    expect(listPendingReportUps(db, TEAM, null).map((r) => r.id)).toEqual([general])
    // Already settled, so a second settlement wins nothing.
    expect(settleReportUps(db, [a, b], 'delivered')).toEqual([])
  })

  it('reports whether a team alert reached the chat or the mailbox', () => {
    db.insert(agents)
      .values({
        id: 'lead',
        name: 'Lead',
        gatewayId: 'lead',
        teamId: TEAM,
        createdAt: 1,
        updatedAt: 1,
      })
      .run()
    expect(writeTeamAlert(db, { teamId: TEAM, roomId: null, agentId: 'lead', text: 'x' })).toBe(
      true,
    )
    resetDb() // the database is gone: neither write can land
    expect(writeTeamAlert(db, { teamId: TEAM, roomId: null, agentId: 'lead', text: 'x' })).toBe(
      false,
    )
  })
})
