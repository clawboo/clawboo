// The real engine, the real run primitive and the real board over sqlite, wired as
// teamOrchestrator's buildInstance wires them, with scripted adapters that hold a
// run open, for the pause scenarios. A sandboxed HOME and CLAWBOO_HOME per test.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { agents, startRefusedBy, teams, type ClawbooDb } from '@clawboo/db'
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
  type BoardOrchestrator,
} from '@clawboo/team-orchestration'
import { expect } from 'vitest'

import { getDb, getDbPath, resetDb } from '../../db'
import { pauseTaskStopNote } from '../../pauseBus'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type QueuedRun, type RunEntry } from '../serverDeliver'
import { stopPausedRunsOf, type PausedRunQuery } from '../teamOrchestrator'

export const TEAM = 'T'
/** What a stopped turn with no task says. */
export const TURN_NOTE = 'Stopped: this agent is paused.'
export const LEAD = 'lead'
export const WORKER = 'worker'
export const OTHER = 'other'
export const skFor = (id: string): string => buildTeamSessionKey(id, TEAM)!

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
}

/** A runtime whose runs hold open until finished or aborted. `abortHangs` leaves the
 *  abort unanswered, as a stuck runtime does. */
export class HeldAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'claude-code'
  started = 0
  aborts = 0
  abortHangs = false
  /** Runs inside `start`: a pause placed while the run is starting. */
  onStart: (() => void) | null = null
  private finish: Array<(reason: 'success' | 'aborted') => void> = []
  /** Aborted before anyone read its events, as a run a pause catches while starting. */
  private abortedBeforeEvents = false
  constructor(private readonly opts: { persistentHome?: boolean } = {}) {}
  capabilities(): Capabilities {
    return this.opts.persistentHome
      ? { ...CAPS, nativeHome: { scope: 'per-identity', persist: true } }
      : CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.started += 1
    this.onStart?.()
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const finish = this.finish
    const sk = run.sessionKey
    const abortedAlready = (): boolean => this.abortedBeforeEvents
    return (async function* () {
      const reason = abortedAlready()
        ? 'aborted'
        : await new Promise<'success' | 'aborted'>((res) => finish.push(res))
      yield {
        kind: 'done',
        reason,
        summary: reason === 'success' ? 'finished' : '',
        runId: sk,
        sessionId: sk,
        ts: 1,
        seq: 1,
      } as RuntimeEvent
    })()
  }
  async abort(): Promise<void> {
    this.aborts += 1
    if (this.abortHangs) return new Promise<void>(() => undefined)
    if (this.finish.length === 0) this.abortedBeforeEvents = true
    for (const f of this.finish.splice(0)) f('aborted')
  }
  /** End the oldest run still going, well. */
  complete(): void {
    this.finish.shift()?.('success')
  }
  get running(): boolean {
    return this.finish.length > 0
  }
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

/** A sandbox home, with the team and its three agents seeded. */
export async function openSandbox(): Promise<{ db: ClawbooDb; close: () => Promise<void> }> {
  const home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-pause-'))
  const prevHome = process.env['HOME']
  const prevClawboo = process.env['CLAWBOO_HOME']
  process.env['HOME'] = home
  process.env['CLAWBOO_HOME'] = home
  resetDb()
  const db = getDb()
  expect(getDbPath().startsWith(home)).toBe(true)
  const now = Date.now()
  db.insert(teams)
    .values({
      id: TEAM,
      name: 'Team',
      icon: 'x',
      color: '#000',
      leaderAgentId: LEAD,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  db.insert(agents)
    .values(
      [LEAD, WORKER, OTHER].map((id) => ({
        id,
        name: id,
        gatewayId: id,
        sourceId: 'claude-code',
        runtime: 'claude-code',
        teamId: TEAM,
        createdAt: now,
        updatedAt: now,
      })),
    )
    .run()
  return {
    db,
    close: async () => {
      resetDb()
      if (prevHome === undefined) delete process.env['HOME']
      else process.env['HOME'] = prevHome
      if (prevClawboo === undefined) delete process.env['CLAWBOO_HOME']
      else process.env['CLAWBOO_HOME'] = prevClawboo
      await rm(home, { recursive: true, force: true })
    },
  }
}

/** The engine and deliver pair, as buildInstance wires them. */
export function wire(db: ClawbooDb, adapters: Map<string, HeldAdapter>) {
  const abortMap = new Map<string, RunEntry>()
  const queuedRuns = new Map<string, QueuedRun>()
  const nudge = createNudgeQueue()
  const meta: string[] = []
  let stopGen = 0
  const engineRef: { current: BoardOrchestrator | null } = { current: null }
  const deliver = createServerDeliver({
    db,
    teamId: TEAM,
    mcpBaseUrl: null,
    nudge,
    abortMap,
    queuedRuns,
    onEvent: (sk, ev, run) => engineRef.current!.onEvent(sk, ev, run),
    onSessionClosed: (sk, run) => engineRef.current!.onSessionClosed(sk, run),
    onRunNotStarted: (run) => engineRef.current!.onRunNotStarted(run),
    taskForSession: (sk) => engineRef.current!.taskForSession(sk),
    execForSession: (sk) => engineRef.current!.execForSession(sk),
    stopGen: () => stopGen,
    leaderAgentId: () => LEAD,
    persistTurn: () => undefined,
    persistMeta: (_sk, text) => {
      meta.push(text)
    },
    makeAdapterForAgent: (agentId) => adapters.get(agentId) ?? null,
  })
  const engine = createBoardOrchestrator({
    teamId: TEAM,
    board: createServerBoardClient(db),
    known: () => [
      { id: LEAD, name: 'Lead' },
      { id: WORKER, name: 'Worker' },
      { id: OTHER, name: 'Other' },
    ],
    leaderAgentId: () => LEAD,
    sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
    agentIdForSession: (sk) => agentIdFromSessionKey(sk),
    deliver,
    stopGen: () => stopGen,
    isSessionBusy: (sk) => abortMap.has(sk),
    isSessionOccupied: (sk) => nudge.isBusy(sk) || abortMap.has(sk),
    isRunQueued: (sk) => queuedRuns.has(sk),
    abortSession: (sk) => {
      const e = abortMap.get(sk)
      if (e) void e.adapter.abort(e.run).catch(() => undefined)
      else queuedRuns.get(sk)?.cancel()
    },
    caps: { maxFanout: 8 },
    runHeldBy: ({ agentId, taskId }) => {
      const refusal = startRefusedBy(db, { agentId, teamId: TEAM, taskId })
      return refusal ? pauseTaskStopNote(refusal) : null
    },
  })
  engineRef.current = engine
  return {
    deliver,
    engine,
    meta,
    queuedRuns,
    abortMap,
    /** teamOrchestrator's pauseRuns. */
    pauseRuns: (covers: (run: PausedRunQuery) => boolean, note: string) =>
      stopPausedRunsOf({ engine, abortMap, queuedRuns, teamId: TEAM }, covers, {
        task: note,
        turn: TURN_NOTE,
      }),
    /** teamOrchestrator's stop(), step for step. */
    stop: async (): Promise<void> => {
      stopGen++
      for (const [, e] of abortMap) void e.adapter.abort(e.run).catch(() => undefined)
      for (const [, q] of queuedRuns) q.cancel()
      nudge.reset()
      await engine.markStopped()
    },
  }
}
