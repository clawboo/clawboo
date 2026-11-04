// Team-chat code work is checked like the task runner's. Wires the REAL engine,
// the REAL run primitive (createServerDeliver), the REAL board and the REAL work
// check over one temp clawboo home, as teamOrchestrator's buildInstance does,
// with scripted adapters through the makeAdapterForAgent seam. The worker's runs
// write into the team folder as a real agent would; the team's verify command
// runs through a shell in that folder.

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agents,
  getTaskVerification,
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
  HUMAN_TURN,
  REFLECT_WINDOW_MS,
  type BoardOrchestrator,
} from '@clawboo/team-orchestration'

import { getDb, getDbPath, resetDb } from '../../db'
import { teamWorkdirPath } from '../../runtimes/teamWorkdir'
import { teamVerifyCommandSettingKey } from '../../verification/teamVerifyCommand'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'
import { createTeamWorkCheck } from '../teamWorkCheck'
import { settle } from './settleCascade'

const TEAM = 'T'
const LEAD = 'lead'
const WORKER = 'worker'
const skFor = (id: string): string => buildTeamSessionKey(id, TEAM)!

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: false,
  toolApproval: true,
  models: [],
  runtimeClass: 'wrapped-oneshot',
}

/** Each start() plays the agent's next turn: `write` files into the team folder
 *  (what the agent did), then the turn's events. */
type Turn = { write?: Record<string, string>; events: RuntimeEvent[] }

class ScriptedAgent implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'claude-code'
  readonly startOpts: StartOpts[] = []
  private readonly pending: RuntimeEvent[][] = []
  constructor(private readonly turns: Turn[]) {}
  capabilities(): Capabilities {
    return CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startOpts.push(opts)
    const turn = this.turns.shift() ?? { events: [] }
    const folder = teamWorkdirPath(TEAM)
    await mkdir(folder, { recursive: true })
    for (const [name, body] of Object.entries(turn.write ?? {}))
      await writeFile(path.join(folder, name), body)
    this.pending.push(turn.events)
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const script = this.pending.shift() ?? []
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

/** Real time the cascade may take: two checks, each running `git` and the verify
 *  command in child processes, which on a loaded Windows runner take seconds each.
 *  Inside the server suites' test timeout on each platform (vitest.config.ts). */
const REAL_BUDGET_MS = process.platform === 'win32' ? 50_000 : 25_000

describe('team-chat code work is checked', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-checked-work-'))
    for (const k of ['HOME', 'CLAWBOO_HOME', 'CLAWBOO_MAX_FIX_CYCLES']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    delete process.env['CLAWBOO_MAX_FIX_CYCLES']
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
          sourceId: 'claude-code',
          runtime: 'claude-code',
          teamId: TEAM,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run()
  })
  afterEach(async () => {
    resetDb()
    vi.clearAllTimers()
    vi.useRealTimers()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  it('a change that fails the team check goes back to its agent, and the lead hears only the pass', async () => {
    setSetting(
      db,
      teamVerifyCommandSettingKey(TEAM),
      JSON.stringify({ command: 'test -f done.txt' }),
    )
    const lead = new ScriptedAgent([
      {
        events: [
          {
            kind: 'tool-call',
            name: 'clawboo-teamchat.team_delegate',
            input: { assignee: 'Worker', task: 'create done.txt' },
            partial: false,
          } as unknown as RuntimeEvent,
          done('handed off'),
        ],
      },
      { events: [done('SYNTHESIS: done.txt is there')] },
    ])
    const worker = new ScriptedAgent([
      { write: { 'wip.txt': 'half way\n' }, events: [done('wrote wip.txt')] },
      { write: { 'done.txt': 'finished\n' }, events: [done('wrote done.txt')] },
    ])
    const adapters = new Map<string, ScriptedAgent>([
      [LEAD, lead],
      [WORKER, worker],
    ])

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
      taskForSession: (sk) => engineRef.current!.taskForSession(sk),
      execForSession: (sk) => engineRef.current!.execForSession(sk),
      stopGen: () => 0,
      leaderAgentId: () => LEAD,
      persistTurn: () => undefined,
      makeAdapterForAgent: (agentId) => adapters.get(agentId) ?? null,
    })
    engineRef.current = createBoardOrchestrator({
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
      workCheck: createTeamWorkCheck({ db, teamId: TEAM, mcpBaseUrl: null }),
    })

    await deliver(skFor(LEAD), LEAD, 'team: create done.txt', HUMAN_TURN)
    await settle(
      () => lead.startOpts.length >= 2,
      "the lead's update after the passing check",
      60 * REFLECT_WINDOW_MS,
      REAL_BUDGET_MS,
    )

    // The worker ran twice: the task, then the fix round with what failed.
    expect(worker.startOpts).toHaveLength(2)
    expect(worker.startOpts[1]!.message).toContain('[Check failed]')
    expect(worker.startOpts[1]!.message).toContain('test -f done.txt')
    expect(worker.startOpts[1]!.message).toContain('create done.txt')

    const task = listTasks(db, { teamId: TEAM })[0]!
    expect(task.status).toBe('done')
    const verdict = getTaskVerification(db, task.id)
    expect(verdict?.status).toBe('pass')
    expect(verdict?.attempts.map((a) => a.status)).toEqual(['fail', 'pass'])

    // The lead heard once, after the pass, with the passing result.
    const updates = lead.startOpts.filter((o) => o.message.startsWith('[Task Update]'))
    expect(updates).toHaveLength(1)
    expect(updates[0]!.message).toContain('wrote done.txt')
    expect(existsSync(path.join(teamWorkdirPath(TEAM), '.git'))).toBe(false)
  })
})
