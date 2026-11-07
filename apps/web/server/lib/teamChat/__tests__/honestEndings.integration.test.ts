// How a run's ending is told apart, end to end. Wires the REAL engine, the REAL run
// primitive (createServerDeliver), the REAL run slots and budget gate and the REAL
// board over one temp SQLite file, with scripted adapters. A "process" is one engine,
// deliver and nudge queue: a restart drops it and builds the next one over the same
// database, which is all that outlives a real restart.

import { mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  attentionForTask,
  agents,
  budgetReservations,
  liftPause,
  listEvents,
  placePause,
  createTask,
  getComments,
  getTask,
  getTaskVerification,
  listExecutions,
  listRoomsWithFireableDelegations,
  recordSpend,
  setBudgetLimit,
  setSetting,
  teams,
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
  type BoardOrchestrator,
} from '@clawboo/team-orchestration'

import { getDb, getDbPath, resetDb } from '../../db'
import { createRunSlots, setRunSlotsForTests, runSlots } from '../../runSlots'
import { startFolderRun, type FolderRun } from '../../runtimes/teamFolderActivity'
import { teamWorkdirPath } from '../../runtimes/teamWorkdir'
import { teamVerifyCommandSettingKey } from '../../verification/teamVerifyCommand'
import { createReportUpOutbox } from '../reportUpOutbox'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'
import { budgetGateRefusal, createTaskWakeOutbox } from '../taskWakes'
import { resetTeamOrchestrators } from '../teamOrchestrator'
import { createTeamWorkCheck } from '../teamWorkCheck'
import { settle } from './settleCascade'

const TEAM = 'T'
const LEAD = 'lead'
const WORKER = 'worker'
const OTHER = 'other'
const BOUND = `r0:deleg:agent:${WORKER}:reflectTo:${LEAD}`
const RATE_LIMIT = '429 rate_limit_error: too many requests'

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: false,
  toolApproval: true,
  models: [],
  runtimeClass: 'wrapped-oneshot',
}

/** A step in a run: an event, something it does in the team folder, or a run that
 *  started and never ends. */
type Step = RuntimeEvent | (() => void) | 'hang'

class ScriptedAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'codex'
  readonly startOpts: StartOpts[] = []
  constructor(private readonly scripts: Step[][]) {}
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
      let seq = 0
      for (const step of script) {
        if (step === 'hang') {
          await new Promise<never>(() => undefined)
          return
        }
        if (typeof step === 'function') {
          step()
          continue
        }
        seq += 1
        yield { ...step, runId: sk, sessionId: sk, ts: seq, seq } as RuntimeEvent
      }
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

const done = (summary: string): RuntimeEvent =>
  ({ kind: 'done', reason: 'success', summary }) as RuntimeEvent
const outOfRoom = (summary: string): RuntimeEvent =>
  ({ kind: 'done', reason: 'max_turns', summary }) as RuntimeEvent
const aborted = (): RuntimeEvent =>
  ({ kind: 'done', reason: 'aborted', summary: '' }) as RuntimeEvent
const fatal = (message: string, code: string | null = null): RuntimeEvent =>
  ({ kind: 'error', code, message, fatal: true }) as RuntimeEvent
const delta = (text: string): RuntimeEvent => ({ kind: 'text-delta', text }) as RuntimeEvent
const spend = (costUsd: number): RuntimeEvent => ({ kind: 'cost', costUsd }) as RuntimeEvent

/** The real time two checks can take: `git` and the verify command, in child processes. */
const REAL_BUDGET_MS = process.platform === 'win32' ? 50_000 : 25_000

function bootProcess(
  db: ClawbooDb,
  adapters: Map<string, ScriptedAdapter>,
  opts: { checked?: boolean } = {},
): { engine: BoardOrchestrator; gen: { value: number } } {
  const engineRef: { current: BoardOrchestrator | null } = { current: null }
  const abortMap = new Map<string, RunEntry>()
  const nudge = createNudgeQueue()
  const gen = { value: 0 }
  const deliver = createServerDeliver({
    db,
    teamId: TEAM,
    mcpBaseUrl: null,
    nudge,
    abortMap,
    onEvent: (sk, ev, run) => engineRef.current!.onEvent(sk, ev, run),
    onSessionClosed: (sk, run) => engineRef.current!.onSessionClosed(sk, run),
    onRunNotStarted: (run) => engineRef.current!.onRunNotStarted(run),
    taskForSession: (sk) => engineRef.current!.taskForSession(sk),
    execForSession: (sk) => engineRef.current!.execForSession(sk),
    stopGen: () => gen.value,
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
      { id: OTHER, name: 'Other' },
    ],
    leaderAgentId: () => LEAD,
    sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
    agentIdForSession: (sk) => agentIdFromSessionKey(sk),
    deliver,
    stopGen: () => gen.value,
    isSessionBusy: (sk) => abortMap.has(sk),
    isSessionOccupied: (sk) => nudge.isBusy(sk) || abortMap.has(sk),
    reportUps: createReportUpOutbox(db, TEAM, null),
    taskWakes: createTaskWakeOutbox(db, TEAM, null),
    budgetRefusal: (taskId, agentId) => {
      const task = getTask(db, taskId)
      return task ? budgetGateRefusal(db, task, agentId) : null
    },
    ...(opts.checked
      ? { workCheck: createTeamWorkCheck({ db, teamId: TEAM, mcpBaseUrl: null }) }
      : {}),
  })
  engineRef.current = engine
  return { engine, gen }
}

describe('honest endings, end to end', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb
  let worker: ScriptedAdapter
  let other: ScriptedAdapter
  let adapters: Map<string, ScriptedAdapter>
  let proc: ReturnType<typeof bootProcess>

  const newTask = (over: Partial<Parameters<typeof createTask>[1]> = {}): DbTask =>
    createTask(db, {
      title: 'fix the bug',
      description: 'fix the bug',
      teamId: TEAM,
      sourceDelegationId: BOUND,
      ...over,
    })
  const script = (...runs: Step[][]): void => {
    worker = new ScriptedAdapter(runs)
    adapters.set(WORKER, worker)
  }
  const statusOf = (id: string): string | undefined => getTask(db, id)?.status
  const waitOf = (id: string): unknown => JSON.parse(getTask(db, id)?.waitingOn ?? 'null')
  const ledger = (id: string) => listExecutions(db, id)
  const reservations = () => db.select().from(budgetReservations).all()
  const noteOf = (id: string): string =>
    getComments(db, id)
      .map((c) => c.body)
      .join('\n')
  const passTime = (ms: number): Promise<unknown> => vi.advanceTimersByTimeAsync(ms)

  beforeEach(async () => {
    // The clears too, or a real clearTimeout is handed a fake timer and stops nothing.
    vi.useFakeTimers({
      toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Date'],
    })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-endings-'))
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
        icon: 'x',
        color: '#e94560',
        leaderAgentId: LEAD,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values(
        [
          [LEAD, 'Lead'],
          [WORKER, 'Worker'],
          [OTHER, 'Other'],
        ].map(([id, name]) => ({
          id: id!,
          name: name!,
          gatewayId: id!,
          sourceId: 'codex',
          runtime: 'codex',
          teamId: TEAM,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run()
    worker = new ScriptedAdapter([])
    other = new ScriptedAdapter([])
    adapters = new Map([
      [LEAD, new ScriptedAdapter([])],
      [WORKER, worker],
      [OTHER, other],
    ])
    setRunSlotsForTests(createRunSlots(1))
    proc = bootProcess(db, adapters)
  })
  afterEach(async () => {
    resetTeamOrchestrators()
    setRunSlotsForTests(null)
    resetDb()
    vi.clearAllTimers()
    vi.useRealTimers()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  describe('a provider failure', () => {
    it('retries twice and then blocks, holding no run slot and no budget hold while it waits', async () => {
      setBudgetLimit(db, { scope: 'team', scopeId: TEAM, limitUsdCents: 10_000, mode: 'cap' })
      script([fatal(RATE_LIMIT)], [fatal(RATE_LIMIT)], [fatal(RATE_LIMIT)])
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'todo', 'the first failure')

      // Waiting: nothing is held, and the card says what it waits for.
      expect(runSlots().stats()).toMatchObject({ running: 0, queued: 0 })
      expect(reservations()).toEqual([])
      expect(waitOf(task.id)).toEqual({ kind: 'retry', cause: 'rate_limited', attempt: 1 })
      expect(attentionForTask(db, task.id)).toBeNull()
      expect(ledger(task.id)).toMatchObject([{ status: 'failed', errorClass: 'RateLimited' }])
      expect(worker.startOpts).toHaveLength(1)

      await passTime(29_000)
      expect(worker.startOpts).toHaveLength(1)
      await settle(() => worker.startOpts.length === 2, 'the first retry', 10_000)
      await settle(() => statusOf(task.id) === 'todo', 'the second failure')
      expect(runSlots().stats()).toMatchObject({ running: 0, queued: 0 })
      expect(reservations()).toEqual([])
      expect(waitOf(task.id)).toEqual({ kind: 'retry', cause: 'rate_limited', attempt: 2 })

      await passTime(59_000)
      expect(worker.startOpts).toHaveLength(2)
      await settle(() => worker.startOpts.length === 3, 'the second retry', 18_000)
      await settle(() => statusOf(task.id) === 'blocked', 'the task blocking')

      expect(waitOf(task.id)).toEqual({ kind: 'provider', cause: 'rate_limited' })
      expect(attentionForTask(db, task.id)).toMatchObject({
        reason: 'rate_limited',
        detail: RATE_LIMIT,
      })
      expect(ledger(task.id).map((e) => e.runReason)).toEqual([
        'delegation',
        'provider_retry',
        'provider_retry',
      ])
      await passTime(3_600_000)
      expect(worker.startOpts).toHaveLength(3)
    })

    it('waits out a pause uncounted, and does not spend a retry', async () => {
      script([fatal(RATE_LIMIT)], [done('got there')])
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'todo', 'the rate limit', 10_000, REAL_BUDGET_MS)
      expect(waitOf(task.id)).toMatchObject({ kind: 'retry', attempt: 1 })

      placePause(db, { kind: 'agent', id: WORKER })
      // The wait runs out with the pause on. Its claim is refused, and that writes nothing.
      await passTime(45_000)
      await settle(() => true, 'the refused claim', 1_000, REAL_BUDGET_MS)
      expect(worker.startOpts).toHaveLength(1)
      expect(ledger(task.id)).toHaveLength(1)
      expect(statusOf(task.id)).toBe('todo')
      expect(waitOf(task.id)).toMatchObject({ kind: 'retry', attempt: 1 })
      expect(listRoomsWithFireableDelegations(db)).toEqual([])
      expect(attentionForTask(db, task.id)).toBeNull()

      liftPause(db, 'agent', WORKER)
      expect(listRoomsWithFireableDelegations(db)).not.toEqual([])
      await proc.engine.resume()
      await settle(() => statusOf(task.id) === 'done', 'the retry', 10_000, REAL_BUDGET_MS)
      expect(worker.startOpts).toHaveLength(2)
      expect(ledger(task.id).map((r) => r.runReason)).toEqual(['delegation', 'provider_retry'])
    })

    it('another run can have the slot during the wait', async () => {
      script([fatal(RATE_LIMIT)], [done('done on the retry')])
      other = new ScriptedAdapter([[done('the other task is done')]])
      adapters.set(OTHER, other)
      const task = newTask()
      const second = newTask({
        title: 'other work',
        description: 'other work',
        sourceDelegationId: `r1:deleg:agent:${OTHER}:reflectTo:${LEAD}`,
      })
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'todo', 'the failure')
      await proc.engine.dispatchTask(second.id)
      await settle(() => statusOf(second.id) === 'done', 'the other run')
      await settle(() => statusOf(task.id) === 'done', 'the retry', 40_000)
      expect(noteOf(task.id)).toContain('done on the retry')
    })

    it('a Stop during the wait cancels it', async () => {
      script([fatal(RATE_LIMIT)])
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'todo', 'the failure')

      proc.gen.value += 1
      await proc.engine.markStopped()
      expect(waitOf(task.id)).toBeNull()
      expect(ledger(task.id).at(-1)?.status).toBe('cancelled')
      expect(attentionForTask(db, task.id)).toMatchObject({ reason: 'stopped' })

      await passTime(3_600_000)
      await proc.engine.resume()
      expect(worker.startOpts).toHaveLength(1)
      expect(listRoomsWithFireableDelegations(db)).toEqual([])
    })

    it('a restart during the wait neither strands the task nor loops', async () => {
      script([fatal(RATE_LIMIT)], ['hang'])
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'todo', 'the failure')
      // What follows the move to To do in the same chain, its wait included, so the
      // restart ends that wait rather than landing just before it starts.
      await passTime(0)

      proc.engine.reset()
      const adapter = worker
      proc = bootProcess(db, adapters)
      // The dispatch pump's scan does not even build an engine for it until the wait ends.
      expect(listRoomsWithFireableDelegations(db)).toEqual([])
      await proc.engine.resume()
      await passTime(10_000)
      await proc.engine.resume()
      expect(adapter.startOpts).toHaveLength(1)

      await passTime(21_000)
      expect(listRoomsWithFireableDelegations(db)).toEqual([{ teamId: TEAM, roomId: null }])
      await proc.engine.resume()
      await settle(() => adapter.startOpts.length === 2, 'the retry')
      await proc.engine.resume()
      await passTime(1_000)
      expect(adapter.startOpts).toHaveLength(2)
      expect(statusOf(task.id)).toBe('in_progress')
      expect(ledger(task.id).at(-1)).toMatchObject({
        status: 'running',
        runReason: 'provider_retry',
      })
      expect(waitOf(task.id)).toBeNull()
    })
  })

  describe('a provider failure on work the check already failed', () => {
    const inFolder = (name: string): string => path.join(teamWorkdirPath(TEAM), name)
    const write =
      (name: string): (() => void) =>
      () => {
        mkdirSync(teamWorkdirPath(TEAM), { recursive: true })
        writeFileSync(inFolder(name), 'half way\n')
      }
    const remove =
      (name: string): (() => void) =>
      () =>
        rmSync(inFolder(name), { force: true })
    const attempts = (id: string) => getTaskVerification(db, id)?.attempts.length ?? 0

    it('keeps the failed verdict, so a retry that undoes the work is still checked', async () => {
      setSetting(
        db,
        teamVerifyCommandSettingKey(TEAM),
        JSON.stringify({ command: 'test -f done.txt' }),
      )
      proc.engine.reset()
      proc = bootProcess(db, adapters, { checked: true })
      script(
        [write('wip.txt'), done('wrote wip.txt')],
        // The fix round hits a rate limit, and the retry of it takes the work back out.
        [fatal(RATE_LIMIT)],
        [remove('wip.txt'), done('took it back out')],
      )
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => worker.startOpts.length >= 2, 'the fix round', 90_000, REAL_BUDGET_MS)
      await settle(() => statusOf(task.id) === 'todo', 'the rate limit', 90_000, REAL_BUDGET_MS)

      // Waiting in To do, the check it failed still stands.
      expect(attempts(task.id)).toBe(1)
      expect(getTaskVerification(db, task.id)?.status).not.toBe('pass')

      await settle(() => worker.startOpts.length >= 3, 'the retry', 90_000, REAL_BUDGET_MS)
      // The retry is still the fix round, told what to fix.
      expect(worker.startOpts[2]!.message).toContain('[Check failed]')
      expect(worker.startOpts[2]!.message).toContain('test -f done.txt')
      expect(ledger(task.id).at(-1)?.runReason).toBe('provider_retry')

      // An unchanged folder after a failed check is still checked: never Done unchecked.
      await settle(() => attempts(task.id) >= 2, 'the second check', 90_000, REAL_BUDGET_MS)
      // And it is the second attempt, not a first one again: the fix loop's bound holds.
      expect(getTaskVerification(db, task.id)?.attempts.map((a) => a.status)).toEqual([
        'fail',
        'completed_with_debt',
      ])
      await settle(() => statusOf(task.id) === 'blocked', 'the block', 90_000, REAL_BUDGET_MS)
      expect(attentionForTask(db, task.id)?.reason).toBe('needs_review')
    })

    it('keeps the verdict and the count through a hold for a teammate too', async () => {
      setSetting(
        db,
        teamVerifyCommandSettingKey(TEAM),
        JSON.stringify({ command: 'test -f done.txt' }),
      )
      proc.engine.reset()
      proc = bootProcess(db, adapters, { checked: true })
      let teammate: FolderRun | null = null
      script(
        [write('wip.txt'), done('wrote wip.txt')],
        [fatal(RATE_LIMIT)],
        // The retry's run ends with a teammate in the folder, so the check waits for it.
        [
          () => {
            teammate = startFolderRun(teamWorkdirPath(TEAM), OTHER)
          },
          write('more.txt'),
          done('wrote more'),
        ],
      )
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => worker.startOpts.length >= 3, 'the retry', 90_000, REAL_BUDGET_MS)
      await settle(() => statusOf(task.id) === 'in_review', 'the hold', 90_000, REAL_BUDGET_MS)
      // It waits for the folder. What it failed still stands, and nothing was counted.
      expect(getTask(db, task.id)?.checkHeldSince).not.toBeNull()
      expect(attempts(task.id)).toBe(1)
      expect(getTaskVerification(db, task.id)?.status).not.toBe('pass')

      teammate!.release()
      await settle(() => attempts(task.id) >= 2, 'the second check', 90_000, REAL_BUDGET_MS)
      expect(getTaskVerification(db, task.id)?.attempts.map((a) => a.status)).toEqual([
        'fail',
        'completed_with_debt',
      ])
      await settle(() => statusOf(task.id) === 'blocked', 'the block', 90_000, REAL_BUDGET_MS)
      expect(attentionForTask(db, task.id)?.reason).toBe('needs_review')
    })

    it('Needs you says the provider, once the retries of a fix round run out', async () => {
      setSetting(
        db,
        teamVerifyCommandSettingKey(TEAM),
        JSON.stringify({ command: 'test -f done.txt' }),
      )
      proc.engine.reset()
      proc = bootProcess(db, adapters, { checked: true })
      script(
        [write('wip.txt'), done('wrote wip.txt')],
        [fatal(RATE_LIMIT)],
        [fatal(RATE_LIMIT)],
        [fatal(RATE_LIMIT)],
      )
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'blocked', 'the block', 300_000, REAL_BUDGET_MS)
      expect(worker.startOpts).toHaveLength(4)
      expect(attempts(task.id)).toBe(1)
      expect(attentionForTask(db, task.id)?.reason).toBe('rate_limited')
    })
  })

  describe('an empty reply', () => {
    it('gets one more turn, then blocks as no result; Needs you says so', async () => {
      script([done('')], [done('  ')])
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'blocked', 'the task blocking')

      expect(worker.startOpts).toHaveLength(2)
      expect(worker.startOpts[1]!.message).toMatch(/ended without a reply/)
      expect(waitOf(task.id)).toEqual({ kind: 'no_result' })
      expect(attentionForTask(db, task.id)).toMatchObject({ reason: 'no_result' })
      expect(ledger(task.id).map((e) => e.runReason)).toContain('empty_reply')
      expect(noteOf(task.id)).toMatch(/twice/)
    })

    it('every run it takes is the engine’s own, and nothing reads as a person’s doing', async () => {
      script([done('')], [outOfRoom('partial')], [done('finished')])
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'done', 'the end', 10_000, REAL_BUDGET_MS)
      expect(ledger(task.id).map((r) => [r.runReason, r.engineRun])).toEqual([
        ['delegation', 1],
        ['empty_reply', 1],
        ['max_turns', 1],
      ])
      const moves = listEvents(db, { taskId: task.id, kinds: ['status_changed'] })
      expect(moves.length).toBeGreaterThan(0)
      for (const move of moves) {
        const data = JSON.parse(move.data ?? '{}') as { actor?: unknown; by?: unknown }
        expect(data.actor).toBeUndefined()
        expect(data.by).toBeUndefined()
      }
    })

    it('tells the continue turn why it runs, in its ticket block', async () => {
      script([done('')], [done('all done')])
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'done', 'the task finishing')
      expect(worker.startOpts[1]!.context).toMatch(/your last turn on it ended without a reply/)
    })

    it('a run whose text came only as deltas did reply', async () => {
      script([delta('fixed in parser.ts'), done('')])
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'done', 'the task finishing')
      expect(worker.startOpts).toHaveLength(1)
      expect(noteOf(task.id)).toContain('fixed in parser.ts')
    })
  })

  describe('running out of room', () => {
    it('continues once, then blocks and says so', async () => {
      script([outOfRoom('first half')], [outOfRoom('second half')])
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'blocked', 'the task blocking')

      expect(worker.startOpts).toHaveLength(2)
      expect(worker.startOpts[1]!.message).toMatch(/ran out of room/i)
      expect(waitOf(task.id)).toEqual({ kind: 'out_of_room' })
      expect(attentionForTask(db, task.id)).toMatchObject({ reason: 'out_of_room' })
      expect(noteOf(task.id)).toContain('first half')
      expect(noteOf(task.id)).toMatch(/twice/)
    })
  })

  describe('a budget stop', () => {
    it('a paused cap is not read as a person’s Stop', async () => {
      setBudgetLimit(db, { scope: 'team', scopeId: TEAM, limitUsdCents: 100, mode: 'cap' })
      recordSpend(db, 'team', TEAM, 150)
      script([done('never runs')])
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'blocked', 'the refusal')

      expect(worker.startOpts).toHaveLength(0)
      expect(ledger(task.id)).toMatchObject([
        { status: 'budget_paused', errorClass: 'BudgetRefused' },
      ])
      expect(waitOf(task.id)).toEqual({ kind: 'budget' })
      expect(attentionForTask(db, task.id)).toMatchObject({ reason: 'budget' })
    })

    it('a cap the run crossed while it went closes it the same way', async () => {
      setBudgetLimit(db, { scope: 'team', scopeId: TEAM, limitUsdCents: 100, mode: 'cap' })
      script([spend(5), aborted()])
      const task = newTask()
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'blocked', 'the kill')
      expect(ledger(task.id).at(-1)?.status).toBe('budget_paused')
      expect(attentionForTask(db, task.id)).toMatchObject({ reason: 'budget' })
    })

    it('a held budget whose cap fills instead goes to Needs you, and stops promising a start', async () => {
      setBudgetLimit(db, { scope: 'team', scopeId: TEAM, limitUsdCents: 100, mode: 'cap' })
      recordSpend(db, 'team', TEAM, 95)
      setRunSlotsForTests(createRunSlots(2))
      other = new ScriptedAdapter([['hang']])
      adapters.set(OTHER, other)
      script([done('never runs')])
      const going = newTask({
        title: 'going',
        description: 'going',
        sourceDelegationId: `r1:deleg:agent:${OTHER}:reflectTo:${LEAD}`,
      })
      const task = newTask()
      await proc.engine.dispatchTask(going.id)
      await settle(() => other.startOpts.length === 1, 'the other run')
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'todo', 'the refusal')
      expect(attentionForTask(db, task.id)).toBeNull()

      // The run holding the room ends, and what it spent crosses the cap.
      db.delete(budgetReservations).run()
      recordSpend(db, 'team', TEAM, 50)
      await passTime(31_000)
      await proc.engine.resume()

      expect(statusOf(task.id)).toBe('blocked')
      expect(waitOf(task.id)).toEqual({ kind: 'budget' })
      expect(attentionForTask(db, task.id)).toMatchObject({ reason: 'budget' })
      expect(noteOf(task.id)).toMatch(/paused at its hard cap/)
      expect(worker.startOpts).toHaveLength(0)
      expect(ledger(task.id)).toHaveLength(1)
    })

    it('a held budget runs again when the budget clears, writing no rows meanwhile', async () => {
      // A cap nearly spent, with its room set aside by a run going on another agent.
      setBudgetLimit(db, { scope: 'team', scopeId: TEAM, limitUsdCents: 100, mode: 'cap' })
      recordSpend(db, 'team', TEAM, 95)
      setRunSlotsForTests(createRunSlots(2))
      other = new ScriptedAdapter([['hang']])
      adapters.set(OTHER, other)
      script([done('ran once the room was back')])
      const going = newTask({
        title: 'going',
        description: 'going',
        sourceDelegationId: `r1:deleg:agent:${OTHER}:reflectTo:${LEAD}`,
      })
      const task = newTask()
      await proc.engine.dispatchTask(going.id)
      await settle(() => other.startOpts.length === 1, 'the other run')
      expect(reservations()).toHaveLength(1)
      await proc.engine.dispatchTask(task.id)
      await settle(() => statusOf(task.id) === 'todo', 'the refusal')

      expect(ledger(task.id)).toMatchObject([{ status: 'budget_held' }])
      expect(waitOf(task.id)).toEqual({ kind: 'budget', held: true })
      expect(attentionForTask(db, task.id)).toBeNull()
      expect(worker.startOpts).toHaveLength(0)

      // Still held: the pump asks the gate, and neither the card nor the ledger moves.
      await passTime(5 * 60_000)
      await proc.engine.resume()
      expect(ledger(task.id)).toHaveLength(1)
      expect(statusOf(task.id)).toBe('todo')

      // The run ends, its hold goes, and the next pass starts the task.
      db.delete(budgetReservations).run()
      await proc.engine.resume()
      await settle(() => statusOf(task.id) === 'done', 'the task running')
      expect(worker.startOpts).toHaveLength(1)
      expect(waitOf(task.id)).toBeNull()
    })
  })
})
