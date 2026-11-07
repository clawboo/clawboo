// A team-chat check waits while another run of the team is working in the team
// folder, so a teammate's half-written change cannot fail someone else's check.
// Wires the REAL engine, the REAL run primitive (createServerDeliver), the REAL
// board and the REAL work check over one temp clawboo home, as teamOrchestrator's
// buildInstance does, with scripted adapters through the makeAdapterForAgent seam.
// A gated run stays in flight until its test lets it finish. The team's verify
// command runs in a child process, and fails while a half-written file is there.

import { existsSync, readFileSync, writeFileSync } from 'node:fs'
import { mkdir, mkdtemp, rm, unlink, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addComment,
  agents,
  createRoom,
  getComments,
  getTaskVerification,
  listExecutions,
  listHeldReportUps,
  listTasks,
  listWaitingTaskWakes,
  reconcileOrphans,
  recordTaskWake,
  setSetting,
  tasks,
  taskWakes,
  teams,
  updateStatus,
  type ClawbooDb,
  type DbTask,
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
import { eq } from 'drizzle-orm'

import { getDb, getDbPath, resetDb } from '../../db'
import { teamWorkdirPath } from '../../runtimes/teamWorkdir'
import { teamVerifyCommandSettingKey } from '../../verification/teamVerifyCommand'
import { createReportUpOutbox } from '../reportUpOutbox'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'
import { createTaskWakeOutbox, pumpTaskWakes } from '../taskWakes'
import { createTeamWorkCheck } from '../teamWorkCheck'
import { settle } from './settleCascade'

// A literal rather than the engine's constant, so this suite also runs against
// a tree that does not have it.
const HOLD_LIMIT_MS = 15 * 60_000
const REAL_BUDGET_MS = process.platform === 'win32' ? 50_000 : 25_000

const TEAM = 'T'
const LEAD = 'lead'
const WORKER = 'worker'
const MATE = 'mate'
const BOT = 'bot'
const THIRD = 'third'
const NAMES: Record<string, string> = {
  [LEAD]: 'Lead',
  [WORKER]: 'Worker',
  [MATE]: 'Mate',
  [BOT]: 'Bot',
  [THIRD]: 'Third',
}

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: false,
  toolApproval: true,
  models: [],
  runtimeClass: 'wrapped-oneshot',
}

const done = (summary: string): RuntimeEvent =>
  ({ kind: 'done', reason: 'success', summary }) as RuntimeEvent

const delegateTo = (assignee: string, task: string): RuntimeEvent =>
  ({
    kind: 'tool-call',
    name: 'clawboo-teamchat.team_delegate',
    input: { assignee, task },
    partial: false,
  }) as unknown as RuntimeEvent

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>((r) => (resolve = r))
  return { promise, resolve }
}

/** One turn of a scripted agent: what it writes as it starts, what holds it in
 *  flight, what it changes as it finishes, and how it ends. */
interface Turn {
  write?: Record<string, string>
  gate?: Promise<void>
  finish?: { write?: Record<string, string>; remove?: string[] }
  events: RuntimeEvent[]
}

class ScriptedAgent implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'claude-code'
  readonly startOpts: StartOpts[] = []
  private readonly pending: Turn[] = []
  constructor(private readonly turns: Turn[]) {}
  capabilities(): Capabilities {
    return CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.startOpts.push(opts)
    const turn = this.turns.shift() ?? { events: [done('nothing more')] }
    const folder = teamWorkdirPath(TEAM)
    await mkdir(folder, { recursive: true })
    for (const [name, body] of Object.entries(turn.write ?? {}))
      await writeFile(path.join(folder, name), body)
    this.pending.push(turn)
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const turn = this.pending.shift() ?? { events: [] }
    const sk = run.sessionKey
    return (async function* () {
      if (turn.gate) await turn.gate
      const folder = teamWorkdirPath(TEAM)
      for (const name of turn.finish?.remove ?? []) await unlink(path.join(folder, name))
      for (const [name, body] of Object.entries(turn.finish?.write ?? {}))
        await writeFile(path.join(folder, name), body)
      let seq = 0
      for (const ev of turn.events) {
        seq += 1
        yield { ...ev, runId: sk, sessionId: sk, ts: seq, seq } as RuntimeEvent
      }
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

describe('a team-chat check holds while a teammate is working in the folder', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb
  let verifyLog: string
  let gen = 0
  const adapters = new Map<string, ScriptedAgent>()

  /** One room's engine and run primitive, wired as buildInstance does. */
  function wire(roomId: string | null = null) {
    const engineRef: { current: BoardOrchestrator | null } = { current: null }
    const abortMap = new Map<string, RunEntry>()
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      chatRoomId: roomId,
      nudge: createNudgeQueue(),
      abortMap,
      onEvent: (sk, ev, run) => engineRef.current!.onEvent(sk, ev, run),
      onSessionClosed: (sk, run) => engineRef.current!.onSessionClosed(sk, run),
      onRunNotStarted: (run) => engineRef.current!.onRunNotStarted(run),
      takeHeldReportUps: (sk) => engineRef.current!.takeHeldReportUps(sk),
      taskForSession: (sk) => engineRef.current!.taskForSession(sk),
      execForSession: (sk) => engineRef.current!.execForSession(sk),
      stopGen: () => gen,
      leaderAgentId: () => LEAD,
      persistTurn: () => undefined,
      makeAdapterForAgent: (agentId) => adapters.get(agentId) ?? null,
    })
    const newEngine = (): BoardOrchestrator =>
      createBoardOrchestrator({
        teamId: TEAM,
        board: createServerBoardClient(db, { roomId }),
        known: () => Object.entries(NAMES).map(([id, name]) => ({ id, name })),
        leaderAgentId: () => LEAD,
        sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM, roomId),
        agentIdForSession: (sk) => agentIdFromSessionKey(sk),
        deliver,
        stopGen: () => gen,
        isSessionBusy: (sk) => abortMap.has(sk),
        workCheck: createTeamWorkCheck({ db, teamId: TEAM, mcpBaseUrl: null }),
        reportUps: createReportUpOutbox(db, TEAM, roomId),
        taskWakes: createTaskWakeOutbox(db, TEAM, roomId),
      })
    engineRef.current = newEngine()
    return {
      deliver,
      engine: () => engineRef.current!,
      restart: () => {
        engineRef.current!.reset()
        engineRef.current = newEngine()
        return engineRef.current
      },
      say: (agentId: string, text: string) =>
        deliver(buildTeamSessionKey(agentId, TEAM, roomId)!, agentId, text, HUMAN_TURN),
    }
  }

  const script = (agentId: string, turns: Turn[]): ScriptedAgent => {
    const agent = new ScriptedAgent(turns)
    adapters.set(agentId, agent)
    return agent
  }

  /** The lead hands one task to `to`, then reports whatever it hears. */
  const scriptLead = (...tasks: Array<[string, string]>): ScriptedAgent =>
    script(LEAD, [
      { events: [...tasks.map(([to, task]) => delegateTo(to, task)), done('handed off')] },
      ...Array.from({ length: 4 }, () => ({ events: [done('noted')] })),
    ])

  const theTask = () => listTasks(db, { teamId: TEAM })[0]
  const verifyRuns = (): number =>
    existsSync(verifyLog) ? readFileSync(verifyLog, 'utf8').trim().split('\n').length : 0
  const askedToFix = (agent: ScriptedAgent): StartOpts[] =>
    agent.startOpts.filter((o) => o.message.includes('[Check failed]'))
  const commentsOf = (taskId: string): string[] => getComments(db, taskId).map((c) => c.body)

  const settleOn = (until: () => boolean, what: string, fakeMs = 60 * REFLECT_WINDOW_MS) =>
    settle(until, what, fakeMs, REAL_BUDGET_MS)

  /** A teammate's run in flight with a half-written file in the folder, and a
   *  worker whose finished task now waits on it. */
  async function workerFinishedBesideMate(room = wire()) {
    const gate = deferred()
    script(MATE, [
      {
        write: { 'half.txt': 'half way\n' },
        gate: gate.promise,
        finish: { remove: ['half.txt'], write: { 'whole.txt': 'finished\n' } },
        events: [done('mate is done')],
      },
    ])
    const worker = script(WORKER, [{ write: { 'w.txt': 'work\n' }, events: [done('wrote w.txt')] }])
    scriptLead(['Worker', 'write w.txt'])
    await room.say(MATE, 'keep going')
    await settleOn(() => adapters.get(MATE)!.startOpts.length === 1, "the teammate's run to start")
    await room.say(LEAD, 'team: write w.txt')
    await settleOn(
      () => worker.startOpts.length >= 1 && theTask()?.status !== 'in_progress',
      "the worker's run to end",
    )
    return { gate, worker, room }
  }

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-check-hold-'))
    for (const k of ['HOME', 'CLAWBOO_HOME', 'CLAWBOO_MAX_FIX_CYCLES']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    delete process.env['CLAWBOO_MAX_FIX_CYCLES']
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    gen = 0
    adapters.clear()
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
        Object.entries(NAMES).map(([id, name]) => ({
          id,
          name,
          gatewayId: id,
          sourceId: id === BOT ? 'openclaw' : 'claude-code',
          runtime: id === BOT ? 'openclaw' : 'claude-code',
          teamId: TEAM,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run()
    // The team's check: logs each run outside the folder, and fails while a
    // half-written file is in it.
    verifyLog = path.join(home, 'verify-runs.log')
    const script_ = path.join(home, 'verify.cjs')
    writeFileSync(
      script_,
      `const fs = require('fs')\n` +
        `fs.appendFileSync(${JSON.stringify(verifyLog)}, 'run\\n')\n` +
        `process.exit(fs.existsSync('half.txt') ? 1 : 0)\n`,
    )
    setSetting(
      db,
      teamVerifyCommandSettingKey(TEAM),
      JSON.stringify({ command: `node "${script_}"` }),
    )
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

  it("waits for the teammate's run, then checks, and the fix note never goes to the wrong agent", async () => {
    const { gate, worker, room } = await workerFinishedBesideMate()
    const id = theTask()!.id

    // Waiting: the check has not run, and the card and the log say so.
    expect(verifyRuns()).toBe(0)
    expect(theTask()!.status).toBe('in_review')
    expect(theTask()!['checkHeldSince']).toEqual(expect.any(Number))
    expect(room.engine().checksInFlight()).toBe(1)
    expect(room.engine().taskForSession(buildTeamSessionKey(WORKER, TEAM)!)).toBe(id)
    expect(commentsOf(id).some((c) => /Mate/.test(c) && /team folder/.test(c))).toBe(true)

    gate.resolve()
    await settleOn(() => theTask()!.status === 'done', 'the check after the teammate finished')

    expect(verifyRuns()).toBe(1)
    expect(askedToFix(worker)).toHaveLength(0)
    const verdict = getTaskVerification(db, id)
    expect(verdict?.status).toBe('pass')
    expect(verdict?.attempts[0]?.hold?.limitReached).toBe(false)
    expect(verdict?.attempts[0]?.hold?.waitedMs).toBeGreaterThanOrEqual(0)
    expect(theTask()!['checkHeldSince']).toBeNull()
    expect(room.engine().checksInFlight()).toBe(0)
  })

  it('does not wait for a run that does not touch the folder (an OpenClaw agent)', async () => {
    const room = wire()
    const gate = deferred()
    const bot = script(BOT, [{ gate: gate.promise, events: [done('bot is done')] }])
    script(WORKER, [{ write: { 'w.txt': 'work\n' }, events: [done('wrote w.txt')] }])
    scriptLead(['Worker', 'write w.txt'])
    await room.say(BOT, 'keep going')
    await settleOn(() => bot.startOpts.length === 1, "the bot's run to start")
    await room.say(LEAD, 'team: write w.txt')
    await settleOn(() => theTask()?.status === 'done', 'the check beside the bot')

    expect(verifyRuns()).toBe(1)
    expect(getTaskVerification(db, theTask()!.id)?.attempts[0]?.hold).toBeUndefined()
    gate.resolve()
  })

  it('a run in another room of the team holds it', async () => {
    const otherRoom = createRoom(db, { teamId: TEAM, name: 'Design', memberIds: [MATE] }).id
    const elsewhere = wire(otherRoom)
    const room = wire()
    const gate = deferred()
    const mate = script(MATE, [
      {
        write: { 'half.txt': 'half way\n' },
        gate: gate.promise,
        finish: { remove: ['half.txt'] },
        events: [done('mate is done')],
      },
    ])
    const worker = script(WORKER, [{ write: { 'w.txt': 'work\n' }, events: [done('wrote w.txt')] }])
    scriptLead(['Worker', 'write w.txt'])
    await elsewhere.say(MATE, 'keep going')
    await settleOn(() => mate.startOpts.length === 1, "the other room's run to start")
    await room.say(LEAD, 'team: write w.txt')
    await settleOn(
      () => worker.startOpts.length >= 1 && theTask()?.status !== 'in_progress',
      "the worker's run to end",
    )

    expect(verifyRuns()).toBe(0)
    expect(theTask()!.status).toBe('in_review')

    gate.resolve()
    await settleOn(() => theTask()!.status === 'done', 'the check after the other room')
    expect(verifyRuns()).toBe(1)
    expect(askedToFix(worker)).toHaveLength(0)
  })

  it('does not delay a teammate who starts while the check waits', async () => {
    const { gate, room } = await workerFinishedBesideMate()
    const third = script(THIRD, [{ events: [done('third is done')] }])

    await room.say(THIRD, 'start now')
    await settleOn(() => third.startOpts.length === 1, "the teammate's start")

    expect(verifyRuns()).toBe(0)
    gate.resolve()
    await settleOn(() => theTask()!.status === 'done', 'the check')
  })

  it('two tasks finishing together both get checked, one after the other', async () => {
    // The check fails if another check of the team is running at the same moment.
    // It stays long enough for a second one to start beside it even on a loaded
    // machine, and both runs end on one gate, so the two checks come due together.
    const lock = path.join(home, 'check.lock')
    const scriptPath = path.join(home, 'verify-alone.cjs')
    writeFileSync(
      scriptPath,
      `const fs = require('fs')\n` +
        `fs.appendFileSync(${JSON.stringify(verifyLog)}, 'run\\n')\n` +
        `try { fs.mkdirSync(${JSON.stringify(lock)}) } catch { process.exit(1) }\n` +
        `setTimeout(() => { fs.rmdirSync(${JSON.stringify(lock)}); process.exit(0) }, 2000)\n`,
    )
    setSetting(
      db,
      teamVerifyCommandSettingKey(TEAM),
      JSON.stringify({ command: `node "${scriptPath}"` }),
    )
    const room = wire()
    const gate = deferred()
    const worker = script(WORKER, [
      { write: { 'w.txt': 'w\n' }, gate: gate.promise, events: [done('wrote w.txt')] },
    ])
    const mate = script(MATE, [
      { write: { 'm.txt': 'm\n' }, gate: gate.promise, events: [done('wrote m.txt')] },
    ])
    scriptLead(['Worker', 'write w.txt'], ['Mate', 'write m.txt'])

    await room.say(LEAD, 'team: write both')
    await settleOn(
      () => worker.startOpts.length === 1 && mate.startOpts.length === 1,
      'both runs to start',
    )
    gate.resolve()
    await settleOn(
      () => listTasks(db, { teamId: TEAM }).every((t) => t.status === 'done') && verifyRuns() >= 2,
      'both checks',
    )

    expect(verifyRuns()).toBe(2)
    expect(askedToFix(worker)).toHaveLength(0)
    expect(askedToFix(mate)).toHaveLength(0)
    for (const t of listTasks(db, { teamId: TEAM }))
      expect(getTaskVerification(db, t.id)?.status).toBe('pass')
    expect(room.engine().checksInFlight()).toBe(0)
  })

  it('at the limit it checks anyway and says so, and the task is not stranded', async () => {
    const { gate, worker, room } = await workerFinishedBesideMate()
    const id = theTask()!.id

    // The teammate never finishes. Past the limit the check runs, and fails on the
    // half-written file; the fix round goes out, saying whose it may be.
    await settleOn(() => verifyRuns() === 1, 'the check at the limit', HOLD_LIMIT_MS + 60_000)
    await settleOn(() => askedToFix(worker).length === 1, 'the fix round')

    const attempt = getTaskVerification(db, id)?.attempts[0]
    expect(attempt?.status).toBe('fail')
    expect(attempt?.hold?.limitReached).toBe(true)
    expect(attempt?.hold?.waitedMs).toEqual(expect.any(Number))
    expect(commentsOf(id).some((c) => /15 minutes/.test(c) && /Mate/.test(c))).toBe(true)
    expect(askedToFix(worker)[0]!.message).toMatch(/may come from .*unfinished work/)

    // The fix round's own check waits for the teammate too, and passes after it.
    gate.resolve()
    await settleOn(() => theTask()!.status === 'done', 'the second check')
    expect(getTaskVerification(db, id)?.status).toBe('pass')
    expect(theTask()!['checkHeldSince']).toBeNull()
    expect(room.engine().checksInFlight()).toBe(0)
  })

  it('a restart during the hold leaves the task for a person', async () => {
    const { gate, room } = await workerFinishedBesideMate()
    const id = theTask()!.id

    const next = room.restart()
    await next.resume()

    expect(theTask()!.status).toBe('blocked')
    expect(commentsOf(id).some((c) => /restart/i.test(c))).toBe(true)
    expect(listExecutions(db, id).at(-1)?.status).toBe('failed')
    expect(verifyRuns()).toBe(0)
    expect(theTask()!['checkHeldSince']).toBeNull()

    gate.resolve()
    await settleOn(
      () => verifyRuns() === 0 && !existsSync(path.join(teamWorkdirPath(TEAM), 'half.txt')),
      'the teammate to finish',
    )
    expect(verifyRuns()).toBe(0)
    expect(getTaskVerification(db, id)).toBeNull()
  })

  it('a restart during a hold older than the stale window still tells whoever handed it out', async () => {
    const { gate, room } = await workerFinishedBesideMate()
    const id = theTask()!.id
    const lead = adapters.get(LEAD)!

    // Nothing beats a task In review, so a long hold looks dead to the boot reap.
    db.update(tasks)
      .set({ updatedAt: Date.now() - 4 * 60_000 })
      .where(eq(tasks.id, id))
      .run()
    const next = room.restart()
    reconcileOrphans(db, { staleAfterMs: 3 * 60_000 })
    expect(theTask()!.status).toBe('in_review')
    await next.resume()

    expect(theTask()!.status).toBe('blocked')
    expect(theTask()!['checkHeldSince']).toBeNull()
    expect(commentsOf(id).some((c) => /restart/i.test(c))).toBe(true)
    expect(listExecutions(db, id).at(-1)?.status).toBe('failed')
    await settleOn(
      () => lead.startOpts.some((o) => o.message.startsWith('[Task Update]')),
      "the lead's update",
    )
    const update = lead.startOpts.find((o) => o.message.startsWith('[Task Update]'))!
    expect(update.message).toMatch(/restart/i)
    gate.resolve()
  })

  it('a card put back to In progress through the API during the hold gets no check', async () => {
    const { gate, room, worker } = await workerFinishedBesideMate()
    const id = theTask()!.id

    expect(updateStatus(db, id, 'in_progress', { actor: 'person' }).ok).toBe(true)
    gate.resolve()
    await settleOn(() => room.engine().checksInFlight() === 0, 'the wait to end')

    expect(verifyRuns()).toBe(0)
    expect(getTaskVerification(db, id)).toBeNull()
    expect(theTask()!.status).toBe('in_progress')
    expect(theTask()!['checkHeldSince']).toBeNull()
    expect(room.engine().taskForSession(buildTeamSessionKey(WORKER, TEAM)!)).toBeNull()
    expect(commentsOf(id).some((c) => c.includes('wrote w.txt'))).toBe(true)
    expect(worker.startOpts).toHaveLength(1)
  })

  it("a person's move during the hold wins, and no verdict lands afterwards", async () => {
    const { gate, room } = await workerFinishedBesideMate()
    const id = theTask()!.id

    expect(updateStatus(db, id, 'cancelled', { actor: 'person' }).ok).toBe(true)
    await room.engine().personMovedTask(id, 'cancelled')
    expect(room.engine().checksInFlight()).toBe(0)
    expect(room.engine().taskForSession(buildTeamSessionKey(WORKER, TEAM)!)).toBeNull()

    gate.resolve()
    await settleOn(
      () => !existsSync(path.join(teamWorkdirPath(TEAM), 'half.txt')),
      'the teammate to finish',
    )
    await vi.advanceTimersByTimeAsync(HOLD_LIMIT_MS + 60_000)

    expect(verifyRuns()).toBe(0)
    expect(getTaskVerification(db, id)).toBeNull()
    expect(theTask()!.status).toBe('cancelled')
    expect(theTask()!['checkHeldSince']).toBeNull()
  })

  it("a person's comment during the hold waits behind the run it holds, and gets its turn before Done", async () => {
    const { gate } = await workerFinishedBesideMate()
    const id = theTask()!.id
    const comment = addComment(db, id, 'Use the new logo.', 'user', null, { kind: 'person' })
    const wake = recordTaskWake(db, {
      teamId: TEAM,
      agentId: WORKER,
      taskId: id,
      reason: 'person_comment',
      commentIds: [comment.id],
    })
    // A held check keeps its run open: one run on the claim, and nothing starts a second.
    expect(listExecutions(db, id).filter((e) => e.status === 'running')).toHaveLength(1)
    const starts: string[] = []
    const pump = {
      held: () => false,
      startForPerson: (t: DbTask) => {
        starts.push(t.id)
      },
      pumpRoom: () => undefined,
      alert: () => true,
    }
    pumpTaskWakes(db, pump)
    expect(starts).toEqual([])
    expect(listWaitingTaskWakes(db)[0]!.skipReason).toBe('under_check')

    const again = script(WORKER, [{ events: [done('used the new logo')] }])
    gate.resolve()
    await settleOn(() => again.startOpts.length === 1, 'the turn for the comment')
    expect(again.startOpts[0]!.context).toContain('Use the new logo.')
    await settleOn(() => theTask()!.status === 'done', 'the task to finish after that turn')
    expect(commentsOf(id)).toContain('used the new logo')
    const row = db.select().from(taskWakes).where(eq(taskWakes.id, wake.id)).get()
    expect(row?.settledHow).toBe('delivered')
    // The reply is work too: the check ran on it, from a starting point of its own.
    expect(verifyRuns()).toBe(2)
    expect(getTaskVerification(db, id)?.status).toBe('pass')
  })

  it('work done in a comment turn after a pass is checked, and a failure does not reach Done', async () => {
    const { gate } = await workerFinishedBesideMate()
    const id = theTask()!.id
    const comment = addComment(db, id, 'Also add half.txt.', 'user', null, { kind: 'person' })
    recordTaskWake(db, {
      teamId: TEAM,
      agentId: WORKER,
      taskId: id,
      reason: 'person_comment',
      commentIds: [comment.id],
    })
    // The team's check fails while half.txt is in the folder.
    script(WORKER, [{ write: { 'half.txt': 'as you asked\n' }, events: [done('added it')] }])
    gate.resolve()
    await settleOn(() => verifyRuns() === 2, 'the check of the turn')
    await settleOn(() => theTask()!.status === 'blocked', 'the task to wait for a person')
    expect(getTaskVerification(db, id)?.attempts.map((a) => a.status)).toEqual([
      'pass',
      'completed_with_debt',
    ])
  })

  it("a Stop during the hold keeps the report for the delegator's next run, and wakes no one", async () => {
    const { gate, room } = await workerFinishedBesideMate()
    const id = theTask()!.id
    const lead = adapters.get(LEAD)!
    const leadRuns = lead.startOpts.length

    gen += 1
    await room.engine().markStopped()
    gate.resolve()
    await settleOn(
      () => !existsSync(path.join(teamWorkdirPath(TEAM), 'half.txt')),
      'the teammate to finish',
    )
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS + 1_000)

    // Nothing started for it, and it is not lost.
    expect(lead.startOpts).toHaveLength(leadRuns)
    expect(
      listHeldReportUps(db, TEAM, null).map((r) => [
        r.taskId,
        (JSON.parse(r.payload) as { outcome?: string }).outcome,
      ]),
    ).toEqual([[id, 'aborted']])

    // The delegator's next run reads it, and says it did not finish.
    await room.say(LEAD, 'where are we?')
    await settleOn(() => lead.startOpts.length === leadRuns + 1, "the lead's next run")
    const context = lead.startOpts.at(-1)!.context ?? ''
    expect(context).toContain('after a person pressed Stop')
    expect(context).toContain('DID NOT COMPLETE')
    expect(context).toContain('wrote w.txt')
    await settleOn(() => listHeldReportUps(db, TEAM, null).length === 0, 'the report to settle')
  })

  it('a Stop during the hold starts no check, and the task goes back to To do', async () => {
    const { gate, room } = await workerFinishedBesideMate()
    const id = theTask()!.id

    gen += 1
    await room.engine().markStopped()
    gate.resolve()
    await settleOn(
      () => !existsSync(path.join(teamWorkdirPath(TEAM), 'half.txt')),
      'the teammate to finish',
    )
    await vi.advanceTimersByTimeAsync(HOLD_LIMIT_MS + 60_000)

    expect(verifyRuns()).toBe(0)
    expect(getTaskVerification(db, id)).toBeNull()
    expect(theTask()!.status).toBe('todo')
    expect(listExecutions(db, id).at(-1)?.status).toBe('cancelled')
    expect(room.engine().checksInFlight()).toBe(0)
    // The run had finished: its report is kept, on the task and on the closed run.
    expect(commentsOf(id)).toContain('wrote w.txt')
    expect(listExecutions(db, id).at(-1)?.summary).toBe('wrote w.txt')
  })
})
