// Saved wakes, end to end. Wires the REAL engine, the REAL run primitive
// (createServerDeliver), the REAL board, the REAL reply path and the REAL wake
// pump over one temp SQLite file, as teamOrchestrator's buildInstance does, with
// scripted adapters injected through the makeAdapterForAgent seam. A "process" is
// one engine + deliver + nudge queue: a restart drops it and builds the next one
// over the same database, which is all that outlives a real restart.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  AGENT_WAKE_WINDOW_MS,
  encodeHumanAssignment,
  MAX_AGENT_WAKES_PER_HOUR,
  MAX_BACK_AND_FORTH,
  parseWaitingOn,
  PAUSED_RUN_CLASS,
} from '@clawboo/board-core'
import {
  addComment,
  agents,
  agentWakeGates,
  attentionForTask,
  answerQuestion,
  askQuestion,
  claimTask,
  completeExecutionProcess,
  createExecutionProcess,
  createSubtask,
  createTask,
  decideAgentWakes,
  executionProcesses,
  getComments,
  getTask,
  handBackTask,
  holdTaskWakes,
  jobRuns,
  jobRunState,
  jobRunStopped,
  jobLimitedTaskIds,
  linkDep,
  listEvents,
  listExecutions,
  listRoomsWithFireableDelegations,
  listTaskQuestions,
  listTasks,
  listUndeliveredInbox,
  listUnsettledTaskWakes,
  listWaitingTaskWakes,
  liftPause,
  LOCAL_PERSON,
  LOCAL_READER,
  markTaskRead,
  noteAgentWakeStarted,
  agentWakeVerdictFor,
  readAgentWakeGate,
  placePause,
  reconcileOrphans,
  listPendingReportUps,
  reconcileStaleInProgress,
  recordTaskWake,
  runOwnWrite,
  reopenTask,
  saveAgentCommentWake,
  setTaskRunnerInputs,
  setTeamAlwaysAllow,
  startRefusedBy,
  taskReadStates,
  tasks,
  taskWakes,
  teams,
  updateStatus,
  wakeCommentIds,
  type ClawbooDb,
  type DbTask,
  type DbTaskWake,
} from '@clawboo/db'
import type {
  Capabilities,
  RunHandle,
  RuntimeAdapter,
  RuntimeEvent,
  StartOpts,
  SteerResult,
  TaskHandle,
} from '@clawboo/executor'
import {
  agentIdFromSessionKey,
  buildTeamSessionKey,
  createBoardOrchestrator,
  createNudgeQueue,
  type BoardOrchestrator,
  type WorkCheck,
  type WorkCheckResult,
} from '@clawboo/team-orchestration'
import { eq, sql } from 'drizzle-orm'

import { getDb, getDbPath, resetDb } from '../../db'
import { stopAsOwnWrite } from '../../boardReader'
import { pauseTaskStopNote } from '../../pauseBus'
import { createReportUpOutbox } from '../reportUpOutbox'
import { deliverPersonReply, type ReplyDeps } from '../personReply'
import { savePersonWake, startPersonWake } from '../personWake'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'
import {
  createTaskWakeOutbox,
  pumpTaskWakes,
  pumpTaskWakesByRoom,
  type TaskWakePumpDeps,
} from '../taskWakes'
import { engineRefusal } from '../roomRoster'
import { resetTeamOrchestrators } from '../teamOrchestrator'
import { createRunSlots, setRunSlotsForTests } from '../../runSlots'
import { registerRunSteer, resetRunSteers } from '../../runSteers'
import { resetCommentSteers, STEER_BATCH_MS } from '../taskSteer'
import { settle } from './settleCascade'

const TEAM = 'T'
const LEAD = 'lead'
const WORKER = 'worker'
const OTHER = 'other'
const BOUND = `r0:deleg:agent:${WORKER}:reflectTo:${LEAD}`
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

/** A step in a run: an event, a side effect in the middle of the run, or a run
 *  that started and never ends (the server dies mid-run). */
type Step = RuntimeEvent | (() => void) | 'hang' | 'advance'

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
        // Time passes inside the run: a batched steer goes in before it ends.
        if (step === 'advance') {
          await vi.advanceTimersByTimeAsync(STEER_BATCH_MS + 100)
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
const fatal = (message: string, code: string | null = null): RuntimeEvent =>
  ({ kind: 'error', code, message, fatal: true }) as RuntimeEvent

function bootProcess(
  db: ClawbooDb,
  adapters: Map<string, ScriptedAdapter>,
): { engine: BoardOrchestrator; abortMap: Map<string, RunEntry> } {
  const engineRef: { current: BoardOrchestrator | null } = { current: null }
  const abortMap = new Map<string, RunEntry>()
  const nudge = createNudgeQueue()
  const deliver = createServerDeliver({
    db,
    teamId: TEAM,
    mcpBaseUrl: null,
    nudge,
    abortMap,
    onEvent: (sk, ev, run) => engineRef.current!.onEvent(sk, ev, run),
    onSessionClosed: (sk, run) => engineRef.current!.onSessionClosed(sk, run),
    onRunNotStarted: (run) => engineRef.current!.onRunNotStarted(run),
    takeHeldReportUps: (sk, taskId) => engineRef.current!.takeHeldReportUps(sk, taskId),
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
      { id: OTHER, name: 'Other' },
    ],
    leaderAgentId: () => LEAD,
    sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
    agentIdForSession: (sk) => agentIdFromSessionKey(sk),
    deliver,
    stopGen: () => 0,
    isSessionBusy: (sk) => abortMap.has(sk),
    isSessionOccupied: (sk) => nudge.isBusy(sk) || abortMap.has(sk),
    reportUps: createReportUpOutbox(db, TEAM, null),
    taskWakes: createTaskWakeOutbox(db, TEAM, null),
    runHeldBy: ({ agentId, taskId }) => {
      const refusal = startRefusedBy(db, { agentId, teamId: TEAM, taskId })
      return refusal ? pauseTaskStopNote(refusal) : null
    },
  })
  engineRef.current = engine
  return { engine, abortMap }
}

describe('saved wakes, end to end', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb
  let worker: ScriptedAdapter
  let adapters: Map<string, ScriptedAdapter>
  let proc: ReturnType<typeof bootProcess>

  /** The reply path, wired to this process's engine as the board route wires it. */
  const replyDeps = (overrides: Partial<ReplyDeps> = {}): ReplyDeps => ({
    dispatch: (_team, id) => {
      void proc.engine.dispatchTask(id)
    },
    steerWaitMs: 50,
    ...overrides,
  })
  const pumpDeps = (overrides: Partial<TaskWakePumpDeps> = {}): TaskWakePumpDeps => ({
    held: () => false,
    startForPerson: (task) => {
      void proc.engine.dispatchTask(task.id)
    },
    startByItself: (task) => {
      void proc.engine.dispatchTask(task.id, { automatic: true })
    },
    pumpRoom: () => {
      void proc.engine.resume()
    },
    alert: () => true,
    ...overrides,
  })
  const newTask = (over: Partial<Parameters<typeof createTask>[1]> = {}): DbTask =>
    createTask(db, {
      title: 'fix the bug',
      description: 'fix the bug',
      teamId: TEAM,
      sourceDelegationId: BOUND,
      ...over,
    })
  const personComment = (taskId: string, body: string) =>
    addComment(db, taskId, body, 'user', null, { kind: 'person' })
  /** A person's comment through the reply path. Its steer window and its wait for
   *  the steer run on the fake clock, so the clock moves past them. */
  const reply = async (taskId: string, body: string, overrides: Partial<ReplyDeps> = {}) => {
    const comment = personComment(taskId, body)
    const out = deliverPersonReply(
      db,
      getTask(db, taskId)!,
      { id: comment.id, body },
      replyDeps(overrides),
    )
    await vi.advanceTimersByTimeAsync(STEER_BATCH_MS + 100)
    return out
  }
  const started = (a: ScriptedAdapter = worker): StartOpts[] => a.startOpts
  const running = (taskId: string) =>
    listExecutions(db, taskId).filter((e) => e.status === 'running')
  const allWakes = (): DbTaskWake[] => db.select().from(taskWakes).all() as DbTaskWake[]
  const skips = () =>
    listEvents(db, { kinds: ['task_wake_skipped'] }).map(
      (e) => (JSON.parse(e.data) as { reason?: string }).reason,
    )

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-task-wakes-'))
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
    adapters = new Map([
      [LEAD, new ScriptedAdapter([])],
      [WORKER, worker],
      [OTHER, new ScriptedAdapter([])],
    ])
    proc = bootProcess(db, adapters)
  })
  afterEach(async () => {
    resetTeamOrchestrators()
    resetRunSteers()
    resetCommentSteers()
    resetDb()
    vi.clearAllTimers()
    vi.useRealTimers()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  const script = (...runs: Step[][]): void => {
    worker = new ScriptedAdapter(runs)
    adapters.set(WORKER, worker)
  }

  describe('under a pause', () => {
    const NOTE = 'Stopped: this agent is paused. The task starts again on resume.'
    const pause = (): void => {
      placePause(db, { kind: 'agent', id: WORKER })
    }
    const resume = (): void => {
      liftPause(db, 'agent', WORKER)
    }
    const stoppedByPause = (): Step[] => [
      () => {
        pause()
        void proc.engine.pauseRuns(() => true, NOTE)
      },
      'advance',
      { kind: 'done', reason: 'aborted', summary: '' } as RuntimeEvent,
    ]
    const closedBy = (taskId: string, status: 'cancelled' | 'failed', byPerson = false): void => {
      const exec = createExecutionProcess(db, { taskId, executorType: 'openclaw' })
      completeExecutionProcess(db, exec.id, { status, byPerson })
    }
    /** Pump as the server does on a resume: the wake pass, and the engine's own. */
    const pumpTwice = async (): Promise<void> => {
      pumpTaskWakes(db, pumpDeps())
      pumpTaskWakes(db, pumpDeps())
      void proc.engine.resume()
      await vi.advanceTimersByTimeAsync(STEER_BATCH_MS + 100)
    }

    it('a comment during a pause fires on resume, exactly once', async () => {
      const task = newTask()
      pause()

      expect(await reply(task.id, 'when you are back')).toEqual({
        status: 'queued',
        agentId: WORKER,
        reason: 'paused',
      })
      await pumpTwice()
      expect(started()).toEqual([])
      const [row] = listWaitingTaskWakes(db)
      expect(row).toMatchObject({ replays: 0, skipReason: 'paused' })
      expect(skips()).toEqual(['paused'])

      resume()
      script([done('back on it')])
      await pumpTwice()
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the resume')
      await vi.advanceTimersByTimeAsync(STEER_BATCH_MS + 100)

      expect(started()).toHaveLength(1)
      expect(started()[0]!.context).toContain('when you are back')
      expect(listExecutions(db, task.id)).toHaveLength(1)
      expect(allWakes()[0]).toMatchObject({ settledHow: 'delivered' })
    })

    it.each([
      ['Blocked', (id: string) => void updateStatus(db, id, 'blocked')],
      ['a person stopped it', (id: string) => closedBy(id, 'cancelled', true)],
      [
        'it was parked',
        (id: string) => {
          for (let i = 0; i < 3; i++) closedBy(id, 'failed')
        },
      ],
    ])('a reply when %s saves a wake, moves nothing, and starts it on resume', async (_n, set) => {
      const task = newTask()
      set(task.id)
      const statusBefore = getTask(db, task.id)!.status
      pause()

      expect(await reply(task.id, 'try it this way')).toMatchObject({ reason: 'paused' })
      await pumpTwice()
      expect(getTask(db, task.id)?.status).toBe(statusBefore)
      expect(started()).toEqual([])
      expect(listWaitingTaskWakes(db)).toHaveLength(1)

      resume()
      script([done('did it')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the resume')
      expect(started()).toHaveLength(1)
      expect(started()[0]!.context).toContain('try it this way')
    })

    it('a wake its run carried goes back to waiting: not counted, and not held as a Stop', async () => {
      const task = newTask()
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'person_comment',
      })
      script(stoppedByPause(), [done('back on it')])
      pumpTaskWakes(db, pumpDeps())
      await settle(
        () => listExecutions(db, task.id).at(-1)?.errorClass === PAUSED_RUN_CLASS,
        'the pause to close the run',
      )
      await settle(() => getTask(db, task.id)?.status === 'todo', 'the task to go back')
      const [row] = listWaitingTaskWakes(db)
      expect(row).toMatchObject({ replays: 0, heldAt: null, carriedExecId: null })

      await pumpTwice()
      expect(started()).toHaveLength(1)
      expect(listWaitingTaskWakes(db)[0]).toMatchObject({ skipReason: 'paused', replays: 0 })

      resume()
      await pumpTwice()
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the resume')
      expect(started()).toHaveLength(2)
      expect(listExecutions(db, task.id).map((e) => e.status)).toEqual(['cancelled', 'succeeded'])
    })

    it('counts for neither the brake nor the replays, however many pauses it sits through', async () => {
      const task = newTask()
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'dependency_done',
      })
      script(stoppedByPause(), stoppedByPause(), stoppedByPause(), [done('back on it')])
      for (let round = 1; round <= 3; round++) {
        pumpTaskWakes(db, pumpDeps())
        await settle(
          () =>
            listExecutions(db, task.id).filter((e) => e.errorClass === PAUSED_RUN_CLASS).length ===
            round,
          'the pause to close the run',
        )
        await settle(() => getTask(db, task.id)?.status === 'todo', 'the task to go back')
        pumpTaskWakes(db, pumpDeps())
        expect(listWaitingTaskWakes(db)[0]).toMatchObject({ replays: 0, skipReason: 'paused' })
        resume()
      }
      await pumpTwice()
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the last resume')
      expect(skips()).not.toContain('braked')
      expect(listEvents(db, { kinds: ['task_wake_given_up'] })).toEqual([])
      expect(db.all(sql`SELECT * FROM delegation_failures`)).toEqual([])
    })

    it('a resume after a restart still fires', async () => {
      const task = newTask()
      pause()
      await reply(task.id, 'when you are back')
      pumpTaskWakes(db, pumpDeps())

      // The server restarts with the pause on: the row and the wake are all that is left.
      proc = bootProcess(db, adapters)
      await proc.engine.resume()
      pumpTaskWakes(db, pumpDeps())
      expect(started()).toEqual([])
      expect(listWaitingTaskWakes(db)[0]).toMatchObject({ skipReason: 'paused', replays: 0 })

      resume()
      script([done('back on it')])
      await pumpTwice()
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the resume')
      expect(started()).toHaveLength(1)
      expect(started()[0]!.context).toContain('when you are back')
    })

    it('a comment that came as the run ended well gets its turn after the resume, short of Done', async () => {
      const task = newTask()
      script(
        [
          () => {
            personComment(task.id, 'one more thing')
            recordTaskWake(db, {
              teamId: TEAM,
              agentId: WORKER,
              taskId: task.id,
              reason: 'person_comment',
            })
            pause()
          },
          done('all done'),
        ],
        [done('did the one more thing')],
      )
      void proc.engine.dispatchTask(task.id)
      await settle(() => getTask(db, task.id)?.status === 'todo', 'the round to be set aside')
      expect(listExecutions(db, task.id).at(-1)?.errorClass).toBe(PAUSED_RUN_CLASS)
      expect(getComments(db, task.id).map((c) => c.body)).toContain('all done')
      expect(listWaitingTaskWakes(db)[0]).toMatchObject({ replays: 0, heldAt: null })
      expect(started()).toHaveLength(1)

      resume()
      await pumpTwice()
      await settle(() => getTask(db, task.id)?.status === 'done', 'the turn after the resume')
      expect(started()).toHaveLength(2)
      expect(started()[1]!.context).toContain('one more thing')
    })

    it('an archived team says so, and its wake goes out when the team comes back', async () => {
      const task = newTask()
      db.update(teams).set({ isArchived: 1 }).where(eq(teams.id, TEAM)).run()

      expect(await reply(task.id, 'for later')).toMatchObject({ reason: 'next-run' })
      pumpTaskWakes(db, pumpDeps())
      expect(listWaitingTaskWakes(db)[0]).toMatchObject({ skipReason: 'team_archived' })
      expect(started()).toEqual([])

      db.update(teams).set({ isArchived: 0 }).where(eq(teams.id, TEAM)).run()
      script([done('did it')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run once it is back')
      expect(started()).toHaveLength(1)
    })

    it('starts tasks in the ready list order, not the order their wakes came in', () => {
      const low = newTask({ title: 'low', priority: -1 })
      const normal = newTask({ title: 'normal', priority: 0 })
      const urgent = newTask({ title: 'urgent', priority: 2 })
      for (const task of [low, normal, urgent]) {
        recordTaskWake(db, {
          teamId: TEAM,
          agentId: WORKER,
          taskId: task.id,
          reason: 'person_comment',
        })
      }
      const order: string[] = []
      pumpTaskWakes(db, pumpDeps({ startForPerson: (task) => order.push(task.title) }))
      expect(order).toEqual(['urgent', 'normal', 'low'])
    })
  })

  describe('one live run per task', () => {
    it('parallel wakes make one row and start one run', async () => {
      script([done('fixed')])
      const task = newTask()
      for (let i = 0; i < 12; i++)
        recordTaskWake(db, {
          teamId: TEAM,
          agentId: WORKER,
          taskId: task.id,
          reason: 'person_comment',
          commentIds: [`c${i}`],
        })
      expect(allWakes()).toHaveLength(1)
      await Promise.all(Array.from({ length: 6 }, () => proc.engine.dispatchTask(task.id)))
      await settle(() => getTask(db, task.id)?.status === 'done', 'the one run')
      expect(started()).toHaveLength(1)
      expect(listExecutions(db, task.id)).toHaveLength(1)
      expect(allWakes()[0]!.settledHow).toBe('delivered')
    })

    it('two wakes for one agent in one pump pass: each task gets its own run, brief and comment', async () => {
      // Served first whichever millisecond each was created in: the scripts go in order.
      const a = newTask({ title: 'task a', description: 'task a', priority: 1 })
      const b = newTask({ title: 'task b', description: 'task b' })
      updateStatus(db, a.id, 'blocked')
      updateStatus(db, b.id, 'blocked')
      for (const [task, body] of [
        [a, 'note for a'],
        [b, 'note for b'],
      ] as const) {
        const c = personComment(task.id, body)
        recordTaskWake(db, {
          teamId: TEAM,
          agentId: WORKER,
          taskId: task.id,
          reason: 'person_comment',
          commentIds: [c.id],
        })
      }
      script([done('a is done')], [done('b is done')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, a.id)?.status === 'done', 'the first task')
      await settle(() => getTask(db, b.id)?.status === 'done', 'the second task')
      expect(started()).toHaveLength(2)
      const byBrief = (brief: string) => started().find((o) => o.message.includes(brief))!
      expect(byBrief('task a').context).toContain('note for a')
      expect(byBrief('task a').context).not.toContain('note for b')
      expect(byBrief('task b').context).toContain('note for b')
      expect(byBrief('task b').context).not.toContain('note for a')
      // Each task's result is its own.
      expect(getComments(db, a.id).map((c) => c.body)).toContain('a is done')
      expect(getComments(db, b.id).map((c) => c.body)).toContain('b is done')
      for (const id of [a.id, b.id])
        expect(listExecutions(db, id).filter((e) => e.status === 'running')).toEqual([])
    })

    it('a run waiting for a run slot is the live run, and takes the comment that came meanwhile', async () => {
      // Every slot is taken, so the task's run waits: claimed, in progress, its context
      // not rendered yet. A comment now rides that run, with no wake of its own.
      const slots = createRunSlots(1)
      setRunSlotsForTests(slots)
      const other = slots.tryAcquire('another-agent')!
      script([done('fixed')])
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      await reply(task.id, 'first thought')
      await settle(() => running(task.id).length === 1, 'the claim')
      expect(started()).toEqual([])
      await reply(task.id, 'second thought')
      pumpTaskWakes(db, pumpDeps())
      expect(listExecutions(db, task.id)).toHaveLength(1)
      other.release()
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started()).toHaveLength(1)
      expect(started()[0]!.message).not.toContain('[New comment]')
      const context = started()[0]!.context ?? ''
      expect(context.split('first thought')).toHaveLength(2)
      expect(context.split('second thought')).toHaveLength(2)
      expect(listExecutions(db, task.id)).toHaveLength(1)
      expect(allWakes().every((w) => w.settledHow === 'delivered')).toBe(true)
      setRunSlotsForTests(null)
    })

    it('a check under way counts as the live run: the pump starts nothing', async () => {
      const task = newTask()
      const exec = claimTask(db, task.id, WORKER, 'codex', {
        run: { executorType: 'openclaw' },
      }).execution!
      updateStatus(db, task.id, 'in_review')
      await reply(task.id, 'one more thing')
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['under_check'])
      expect(listExecutions(db, task.id).map((e) => e.id)).toEqual([exec.id])
      expect(started()).toEqual([])
    })

    it('a fix round waiting to go out counts too', async () => {
      const task = newTask()
      claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      await reply(task.id, 'and this')
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['run_live'])
      expect(running(task.id)).toHaveLength(1)
      expect(listWaitingTaskWakes(db)).toHaveLength(1)
    })

    it('never folds into a run that is not proven alive: the wake survives until the sweep', async () => {
      script([done('picked up')])
      const task = newTask()
      claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      await reply(task.id, 'are you there?')
      // The process driving that run died: its beats stopped.
      db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, task.id)).run()
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['run_unproven'])
      expect(listWaitingTaskWakes(db)).toHaveLength(1)
      // The sweep frees it and the next pump delivers the comment.
      expect(reconcileStaleInProgress(db, 1_000).reconciled).toBe(1)
      pumpTaskWakes(db, pumpDeps())
      await settle(() => started().length === 1, 'the run for the comment')
      expect(started()[0]!.context).toContain('are you there?')
    })
  })

  describe('a comment that arrives during a run', () => {
    it('reaches the next turn, once, when the run could not take it', async () => {
      const task = newTask()
      script(
        [
          () => {
            void reply(task.id, 'also check the logs')
          },
          done('all done'),
        ],
        [done('checked the logs too')],
      )
      await proc.engine.dispatchTask(task.id)
      await settle(() => getTask(db, task.id)?.status === 'done', 'both turns')
      expect(started()).toHaveLength(2)
      expect(started()[0]!.context ?? '').not.toContain('also check the logs')
      const turn = started()[1]!
      expect(turn.message).toContain('[New comment]')
      expect((turn.context ?? '').split('also check the logs')).toHaveLength(2)
      expect(allWakes().map((w) => w.settledHow)).toEqual(['delivered'])
      expect(listExecutions(db, task.id).map((e) => e.runReason)).toEqual([
        'delegation',
        'person_comment',
      ])
    })

    it('goes in as one steer for the batch on a run that takes them live', async () => {
      const task = newTask()
      claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      const steers: string[] = []
      const handle = registerRunSteer(
        task.id,
        {
          capabilities: () => ({ ...CAPS, steering: 'live' }),
          steer: async (_r: RunHandle, text: string): Promise<SteerResult> => {
            steers.push(text)
            return { delivered: true, mode: 'live' }
          },
        },
        { adapterId: 'codex', sessionKey: skFor(WORKER), runId: null },
      )
      await Promise.all([reply(task.id, 'first note'), reply(task.id, 'second note')])
      await vi.advanceTimersByTimeAsync(5_000)
      expect(steers).toHaveLength(1)
      expect(steers[0]).toContain('first note')
      expect(steers[0]).toContain('second note')
      // Nothing waits for a later turn. The run carries them, and they count as heard
      // only when it ends well.
      expect(listWaitingTaskWakes(db)).toEqual([])
      expect(allWakes().every((w) => w.settledAt === null)).toBe(true)
      const exec = getTask(db, task.id)!.runExecutionId!
      expect(allWakes().every((w) => w.carriedExecId === exec)).toBe(true)
      completeExecutionProcess(db, exec, { status: 'succeeded', summary: 'done' })
      expect(allWakes().every((w) => w.settledHow === 'delivered')).toBe(true)
      handle.release()
    })

    it('a steer that landed in a run that then died goes out again on the next run', async () => {
      const task = newTask()
      claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      const handle = registerRunSteer(
        task.id,
        {
          capabilities: () => ({ ...CAPS, steering: 'live' }),
          steer: async (): Promise<SteerResult> => ({ delivered: true, mode: 'live' }),
        },
        { adapterId: 'codex', sessionKey: skFor(WORKER), runId: null },
      )
      await reply(task.id, 'use the staging DB')
      handle.release()
      // The server dies with no terminal: nothing wrote a session pointer.
      db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, task.id)).run()
      expect(reconcileOrphans(db, { staleAfterMs: 1_000 }).reconciled).toBe(1)
      const [row] = listWaitingTaskWakes(db)
      expect(row?.replays).toBe(1)
      expect(wakeCommentIds(row!)).toHaveLength(1)
      script([done('used it')])
      proc = bootProcess(db, adapters)
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the next run')
      expect(started()[0]!.context).toContain('use the staging DB')
      expect(allWakes().map((w) => w.settledHow)).toEqual(['delivered'])
    })

    it('a long comment the steer could not carry whole gets the next turn, whole', async () => {
      const task = newTask()
      const tail = 'the part past the cut'
      const long = `${'a'.repeat(1_500)}${tail}`
      const steers: string[] = []
      let handle = { release: () => undefined as void }
      script(
        [
          () => {
            handle = registerRunSteer(
              task.id,
              {
                capabilities: () => ({ ...CAPS, steering: 'live' }),
                steer: async (_r: RunHandle, text: string): Promise<SteerResult> => {
                  steers.push(text)
                  return { delivered: true, mode: 'live' }
                },
              },
              { adapterId: 'codex', sessionKey: skFor(WORKER), runId: null },
            )
            void reply(task.id, long)
          },
          'advance',
          done('all done'),
        ],
        [done('read all of it')],
      )
      await proc.engine.dispatchTask(task.id)
      await settle(() => getTask(db, task.id)?.status === 'done', 'both turns')
      handle.release()
      expect(steers).toHaveLength(1)
      expect(steers[0]).not.toContain(tail)
      expect(started()).toHaveLength(2)
      expect(started()[1]!.message).toContain('[New comment]')
      expect(started()[1]!.context).toContain(tail)
    })

    it('stays waiting when the steer did not land', async () => {
      const task = newTask()
      claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      const handle = registerRunSteer(
        task.id,
        {
          capabilities: () => ({ ...CAPS, steering: 'live' }),
          steer: async (): Promise<SteerResult> => ({ delivered: false, reason: 'rejected' }),
        },
        { adapterId: 'codex', sessionKey: skFor(WORKER), runId: null },
      )
      expect((await reply(task.id, 'can you hear me')).status).toBe('queued')
      expect(wakeCommentIds(listWaitingTaskWakes(db)[0]!)).toHaveLength(1)
      handle.release()
    })
  })

  describe("a person's comment", () => {
    it('a run it starts later reads as theirs, and what the run does next is news', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      const comment = runOwnWrite(db, LOCAL_READER, task.id, () =>
        personComment(task.id, 'try the other file'),
      )
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'person_comment',
        commentIds: [comment.id],
      })
      const unread = () => taskReadStates(db, LOCAL_READER).get(task.id)?.unread
      let duringRun: boolean | undefined
      script([
        () => {
          duringRun = unread()
        },
        done('fixed it'),
      ])
      pumpTaskWakes(db, pumpDeps({ held: () => true }))
      expect(getTask(db, task.id)?.status).toBe('blocked')
      expect(started()).toEqual([])

      pumpTaskWakes(db, pumpDeps())

      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started()).toHaveLength(1)
      expect(duringRun).toBe(false)
      expect(unread()).toBe(true)
    })

    it('shows once in the run it wakes', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      script([done('answered')])
      await reply(task.id, 'use the staging key')
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      const context = started()[0]!.context ?? ''
      expect(context.split('use the staging key')).toHaveLength(2)
      expect(context).not.toContain('A person commented on your task')
    })

    it('a second reply folds into the first durably, not by a timer', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      // The agent is busy, so the first reply's run waits.
      script()
      const first = await reply(task.id, 'first', { dispatch: () => undefined })
      const second = await reply(task.id, 'second', { dispatch: () => undefined })
      expect(first.status).toBe('woke-agent')
      expect(second.status).toBe('woke-agent')
      const rows = listWaitingTaskWakes(db)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.mergeCount).toBe(2)
      expect(wakeCommentIds(rows[0]!)).toHaveLength(2)
      // A note is written for the one start, not per reply.
      expect(
        getComments(db, task.id).filter((c) => c.body.startsWith('Started again')),
      ).toHaveLength(1)
    })

    it("wakes only the task's agent: a mention stays text", async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      script([done('answered')])
      await reply(task.id, '@Other could you look at this too')
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started()).toHaveLength(1)
      expect(started(adapters.get(OTHER))).toEqual([])
      expect(allWakes().map((w) => w.agentId)).toEqual([WORKER])
    })
  })

  describe('a dependency finished', () => {
    const dependentOn = (blocker: DbTask): DbTask => {
      const dependent = newTask({ title: 'next step', description: 'next step' })
      linkDep(db, dependent.id, blocker.id)
      return dependent
    }

    it('through a path in this process saves the wake, and the pump starts it for its reason', async () => {
      const blocker = newTask({
        title: 'first step',
        sourceDelegationId: `r0:deleg:agent:${OTHER}:reflectTo:${LEAD}`,
      })
      const dependent = dependentOn(blocker)
      script([done('next step done')])
      claimTask(db, blocker.id, OTHER, 'codex', { run: { executorType: 'openclaw' } })
      updateStatus(db, blocker.id, 'done')
      expect(listWaitingTaskWakes(db).map((w) => w.taskId)).toEqual([dependent.id])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, dependent.id)?.status === 'done', 'the dependent')
      expect(listExecutions(db, dependent.id)[0]!.runReason).toBe('dependency_done')
      expect(started()[0]!.context).toContain('Why this run: a task it was waiting on is finished')
    })

    it('a dependent left for the wait of a braked ledger waits, and says so', async () => {
      const blocker = newTask({
        title: 'first step',
        sourceDelegationId: `r0:deleg:agent:${OTHER}:reflectTo:${LEAD}`,
      })
      const dependent = dependentOn(blocker)
      for (let i = 0; i < 2; i++) {
        const e = createExecutionProcess(db, { taskId: dependent.id, executorType: 'openclaw' })
        completeExecutionProcess(db, e.id, { status: 'timed_out', error: 'x' })
      }
      claimTask(db, blocker.id, OTHER, 'codex', { run: { executorType: 'openclaw' } })
      updateStatus(db, blocker.id, 'done')
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['braked'])
      expect(listWaitingTaskWakes(db)).toHaveLength(1)
    })
  })

  describe('the no-progress brake', () => {
    const failTwice = (taskId: string): void => {
      for (let i = 0; i < 2; i++) {
        const c = claimTask(db, taskId, WORKER, 'codex', { run: { executorType: 'openclaw' } })
        db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, taskId)).run()
        expect(c.ok).toBe(true)
        expect(reconcileStaleInProgress(db, 1_000).reconciled).toBe(1)
      }
    }

    it('after 2 runs with no progress the scan no longer rebuilds an engine for it', async () => {
      const task = newTask()
      expect(listRoomsWithFireableDelegations(db)).toHaveLength(1)
      failTwice(task.id)
      expect(listRoomsWithFireableDelegations(db)).toEqual([])
      await proc.engine.resume()
      expect(started()).toEqual([])
    })

    it('a run released with progress is not braked', async () => {
      const task = newTask()
      const c = claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      createTask(db, { title: 'child', teamId: TEAM, parentTaskId: task.id })
      completeExecutionProcess(db, c.execution!.id, { status: 'failed', error: 'x' })
      updateStatus(db, task.id, 'todo')
      const again = claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      completeExecutionProcess(db, again.execution!.id, { status: 'failed', error: 'x' })
      updateStatus(db, task.id, 'todo')
      expect(listRoomsWithFireableDelegations(db)).toHaveLength(1)
    })

    it("a person's comment skips the wait", async () => {
      const task = newTask()
      failTwice(task.id)
      script([done('answered')])
      expect((await reply(task.id, 'try again please')).status).toBe('woke-agent')
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started()).toHaveLength(1)
    })

    it('a comment merged into a wake that keeps replaying starts it too, as the drawer says', async () => {
      const task = newTask()
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'person_comment',
        commentIds: ['earlier'],
      })
      // Two runs carrying the wake died, so it has replays and the ledger is braked.
      failTwice(task.id)
      const [row] = listWaitingTaskWakes(db)
      expect(row!.replays).toBe(2)
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().includes('braked'), 'the brake holding it back')
      script([done('answered')])
      expect((await reply(task.id, 'try again please')).status).toBe('woke-agent')
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started()).toHaveLength(1)
      expect(started()[0]!.context).toContain('try again please')
      expect(listWaitingTaskWakes(db)).toEqual([])
    })

    it('a comment merged into a finished dependency waiting on the brake starts it too', async () => {
      const task = newTask()
      failTwice(task.id)
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'dependency_done',
      })
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().includes('braked'), 'the brake holding it back')
      script([done('answered')])
      await reply(task.id, 'go on')
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started()).toHaveLength(1)
    })

    it('a start the hold refused is not a run without progress', async () => {
      const task = newTask()
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'dependency_done',
      })
      for (let i = 0; i < 5; i++) pumpTaskWakes(db, pumpDeps({ held: () => true }))
      expect(listExecutions(db, task.id)).toEqual([])
      expect(listRoomsWithFireableDelegations(db)).toHaveLength(1)
    })
  })

  describe('every skipped wake leaves a visible reason', () => {
    it('a held engine: stays waiting, uncounted, one event for the wait', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      const out = await reply(task.id, 'when you are back', { held: () => true })
      expect(out).toMatchObject({ status: 'queued', reason: 'held' })
      expect(getTask(db, task.id)?.status).toBe('blocked')
      for (let i = 0; i < 3; i++) pumpTaskWakes(db, pumpDeps({ held: () => true }))
      expect(skips()).toEqual(['held'])
      const [row] = listWaitingTaskWakes(db)
      expect(row!.replays).toBe(0)
      expect(row!.skipReason).toBe('held')
      // The hold lifts and the pass that follows starts it.
      script([done('back on it')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the hold')
      expect(started()[0]!.context).toContain('when you are back')
    })

    it('a run the budget refused: stays waiting, uncounted, with its own reason, until the cap is raised', async () => {
      const task = newTask()
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'person_comment',
      })
      const exec = claimTask(db, task.id, WORKER, 'codex', {
        run: { executorType: 'openclaw' },
      }).execution!
      updateStatus(db, task.id, 'blocked')
      completeExecutionProcess(db, exec.id, {
        status: 'failed',
        error: 'over the cap',
        errorClass: 'BudgetRefused',
      })
      const refuses = { now: true }
      const deps = pumpDeps({ budgetRefuses: () => refuses.now })
      for (let i = 0; i < 3; i++) pumpTaskWakes(db, deps)
      const [row] = listWaitingTaskWakes(db)
      expect(row!.replays).toBe(0)
      expect(row!.skipReason).toBe('budget')
      expect(skips()).toEqual(['budget'])
      expect(listRoomsWithFireableDelegations(db)).toEqual([])
      expect(getTask(db, task.id)?.status).toBe('blocked')
      // A person raises the cap: the next pass sends it.
      refuses.now = false
      script([done('back on it')])
      pumpTaskWakes(db, deps)
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the cap rose')
      expect(started()).toHaveLength(1)
    })

    it('a cap that would refuse the run: the card stays put, with no note, and the reason is budget', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'person_comment',
      })
      const before = getComments(db, task.id).length
      const starts: string[] = []
      const deps = pumpDeps({
        budgetRefuses: () => true,
        startForPerson: (t) => {
          starts.push(t.id)
        },
      })
      for (let i = 0; i < 3; i++) pumpTaskWakes(db, deps)
      expect(starts).toEqual([])
      expect(getTask(db, task.id)?.status).toBe('blocked')
      expect(getComments(db, task.id)).toHaveLength(before)
      expect(skips()).toEqual(['budget'])
      expect(listWaitingTaskWakes(db)[0]!.replays).toBe(0)
    })

    it.each(['person_comment', 'dependency_done'] as const)(
      'a run a cap killed gives its %s wake back, and raising the cap sends it',
      (reason) => {
        const task = newTask()
        const wake = recordTaskWake(db, {
          teamId: TEAM,
          agentId: WORKER,
          taskId: task.id,
          reason,
        })
        const run = claimTask(db, task.id, WORKER, 'claude-code', {
          run: { executorType: 'claude-code' },
        })
        expect(run.ok).toBe(true)
        const execId = listExecutions(db, task.id).at(-1)!.id
        completeExecutionProcess(db, execId, {
          status: 'budget_paused',
          error: 'budget_paused:team',
          errorClass: 'BudgetRefused',
        })
        updateStatus(db, task.id, 'todo')
        const [row] = listWaitingTaskWakes(db)
        expect(row?.id).toBe(wake.id)
        expect(row?.heldAt).toBeNull()
        expect(row?.replays).toBe(0)
        const starts: string[] = []
        const byItself: string[] = []
        const hands = {
          startForPerson: (t: DbTask): void => {
            starts.push(t.id)
          },
          startByItself: (t: DbTask): void => {
            byItself.push(t.id)
          },
        }
        pumpTaskWakes(db, pumpDeps({ budgetRefuses: () => true, ...hands }))
        expect([...starts, ...byItself]).toEqual([])
        expect(skips()).toEqual(['budget'])
        pumpTaskWakes(db, pumpDeps({ budgetRefuses: () => false, ...hands }))
        // A cap raised lets it go, and only a person's own start goes free of its job.
        expect(starts).toEqual(reason === 'person_comment' ? [task.id] : [])
        expect(byItself).toEqual(reason === 'person_comment' ? [] : [task.id])
      },
    )

    it('a task that finished first settles the wake and says so on the card', async () => {
      const task = newTask()
      claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      await reply(task.id, 'too late?')
      updateStatus(db, task.id, 'done')
      pumpTaskWakes(db, pumpDeps())
      expect(allWakes().map((w) => w.settledHow)).toEqual(['finished'])
      expect(getComments(db, task.id).some((c) => c.body.includes('finished before'))).toBe(true)
    })

    it('a room that is gone says so, and leaves the wake waiting', async () => {
      const task = newTask({ roomId: 'gone' })
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'dependency_done',
      })
      const rooms: Array<string | null> = []
      pumpTaskWakes(db, pumpDeps({ pumpRoom: (_t, roomId) => rooms.push(roomId) }))
      expect(rooms).toEqual([])
      expect(skips()).toEqual(['no_team'])
      expect(listWaitingTaskWakes(db)).toHaveLength(1)
    })

    it('gives up with an alert after 3 replays, and only once told', async () => {
      const task = newTask()
      const { id } = recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'person_comment',
      })
      db.update(taskWakes).set({ replays: 3 }).where(eq(taskWakes.id, id)).run()
      const alerts: string[] = []
      pumpTaskWakes(db, pumpDeps({ alert: () => false }))
      expect(allWakes()[0]!.settledAt).toBeNull()
      pumpTaskWakes(
        db,
        pumpDeps({
          alert: (a) => {
            alerts.push(a.text)
            return true
          },
        }),
      )
      expect(alerts).toHaveLength(1)
      expect(alerts[0]).toContain('fix the bug')
      expect(allWakes()[0]!.settledHow).toBe('gave_up')
    })
  })

  describe("a person's Stop", () => {
    const withStopGen = (
      workCheck?: WorkCheck,
    ): {
      engine: BoardOrchestrator
      stop: () => Promise<void>
      adapter: ScriptedAdapter
    } => {
      const gen = { value: 0 }
      const engineRef: { current: BoardOrchestrator | null } = { current: null }
      const abortMap = new Map<string, RunEntry>()
      const nudge = createNudgeQueue()
      const deliver = createServerDeliver({
        db,
        teamId: TEAM,
        mcpBaseUrl: null,
        nudge,
        abortMap,
        onEvent: (sk, ev, run) => engineRef.current!.onEvent(sk, ev, run),
        onSessionClosed: (sk, run) => engineRef.current!.onSessionClosed(sk, run),
        onRunNotStarted: (run) => engineRef.current!.onRunNotStarted(run),
        takeHeldReportUps: (sk, taskId) => engineRef.current!.takeHeldReportUps(sk, taskId),
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
        ...(workCheck ? { workCheck } : {}),
      })
      engineRef.current = engine
      proc = { engine, abortMap }
      return {
        engine,
        adapter: worker,
        stop: async () => {
          gen.value += 1
          nudge.reset()
          await engine.markStopped()
        },
      }
    }

    it('holds a waiting comment: no run starts, and the next run on the task takes it', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      await reply(task.id, 'when you get back', { dispatch: () => undefined })
      const { stop, engine } = withStopGen()
      await stop()
      const rows = listUnsettledTaskWakes(db, TEAM)
      expect(rows).toHaveLength(1)
      expect(rows[0]!.settledAt).toBeNull()
      expect(rows[0]!.heldAt).not.toBeNull()
      // The pump leaves it alone, and nothing starts.
      pumpTaskWakes(db, pumpDeps())
      await vi.advanceTimersByTimeAsync(5_000)
      expect(started()).toEqual([])
      expect(skips()).toEqual([])
      // A person's Retry: its run takes the comment, and it settles with that run.
      script([done('back at it')])
      await engine.dispatchTask(task.id)
      await settle(() => getTask(db, task.id)?.status === 'done', 'the Retry')
      expect(started()[0]!.context).toContain('when you get back')
      expect(allWakes().map((w) => w.settledHow)).toEqual(['delivered'])
    })

    it("a person's new comment lifts the hold and starts it", async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      await reply(task.id, 'first thought', { dispatch: () => undefined })
      const { stop, engine } = withStopGen()
      await stop()
      script([done('both read')])
      const comment = personComment(task.id, 'second thought')
      await deliverPersonReply(
        db,
        getTask(db, task.id)!,
        { id: comment.id, body: 'second thought' },
        replyDeps({
          dispatch: (_t, id) => {
            void engine.dispatchTask(id)
          },
        }),
      )
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      const context = started()[0]!.context ?? ''
      expect(context).toContain('first thought')
      expect(context).toContain('second thought')
    })

    it('a task that closed after the Stop closes the row too', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      await reply(task.id, 'never mind', { dispatch: () => undefined })
      const { stop } = withStopGen()
      await stop()
      updateStatus(db, task.id, 'cancelled')
      pumpTaskWakes(db, pumpDeps())
      expect(allWakes().map((w) => w.settledHow)).toEqual(['finished'])
    })

    it("a person's Stop reads as their own: the task stays read, and the wake is held", async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      const { stop, engine } = withStopGen()
      script(['hang'])
      await reply(task.id, 'please do this', {
        dispatch: (_t, id) => {
          void engine.dispatchTask(id)
        },
      })
      await settle(() => started().length === 1, 'the run')
      markTaskRead(
        db,
        LOCAL_READER,
        task.id,
        taskReadStates(db, LOCAL_READER).get(task.id)!.activity!.seq,
      )

      await stopAsOwnWrite(db, LOCAL_READER, { teamId: TEAM, roomId: null }, stop)

      expect(getTask(db, task.id)?.status).toBe('todo')
      expect(taskReadStates(db, LOCAL_READER).get(task.id)?.unread).toBe(false)
      expect(allWakes()[0]!.heldAt).not.toBeNull()
    })

    it('a wake a run carried when the Stop landed is held for the next run, not dropped', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      const { stop, engine } = withStopGen()
      script(['hang'])
      await reply(task.id, 'please do this', {
        dispatch: (_t, id) => {
          void engine.dispatchTask(id)
        },
      })
      await settle(() => started().length === 1, 'the run')
      expect(allWakes()[0]!.carriedExecId).not.toBeNull()
      await stop()
      const [row] = allWakes()
      expect(row!.settledAt).toBeNull()
      expect(row!.carriedExecId).toBeNull()
      expect(row!.heldAt).not.toBeNull()
      expect(row!.replays).toBe(0)
    })

    it("a step a check's pass unblocked after the Stop starts nothing, on either path", async () => {
      const blocker = newTask({
        title: 'first step',
        sourceDelegationId: `r0:plan:0:agent:${OTHER}:reflectTo:${LEAD}`,
      })
      const step = newTask({ title: 'second step', description: 'second step' })
      linkDep(db, step.id, blocker.id)
      const results: Array<(r: WorkCheckResult) => void> = []
      const { stop, engine } = withStopGen({
        begin: async () => undefined,
        prepare: async () => async () => {
          updateStatus(db, blocker.id, 'in_review')
          return new Promise<WorkCheckResult>((resolve) => results.push(resolve))
        },
      })
      adapters.set(OTHER, new ScriptedAdapter([[done('first is done')]]))
      await engine.dispatchTask(blocker.id)
      await settle(() => results.length === 1, 'the check')
      await stop()
      results[0]!({ verdict: 'pass' })
      await settle(() => getTask(db, blocker.id)?.status === 'done', 'the pass')
      script([done('should not run')])
      // Neither the wake pass nor the scan starts it.
      pumpTaskWakes(db, pumpDeps({ pumpRoom: () => void engine.resume() }))
      await vi.advanceTimersByTimeAsync(10_000)
      expect(started()).toEqual([])
      expect(listRoomsWithFireableDelegations(db)).toEqual([])
      expect(skips()).toEqual(['stopped'])
      expect(getTask(db, step.id)?.status).toBe('todo')
    })

    it("the lead's next run carries a report-up the Stop held, in its context, and settles it", async () => {
      const lead = new ScriptedAdapter([[done('Noted, and on it.')]])
      adapters.set(LEAD, lead)
      const { stop, engine } = withStopGen()
      const outbox = createReportUpOutbox(db, TEAM, null)
      const id = outbox.record(
        { toAgentId: LEAD, by: 'Worker', title: 'fix the bug', summary: 'the fix is in' },
        { held: true },
      )
      void stop
      // Nothing wakes the lead for it.
      await engine.resume()
      await vi.advanceTimersByTimeAsync(10_000)
      expect(started(lead)).toEqual([])
      // Its next run, here a person's message, takes it.
      const deliver = createServerDeliver({
        db,
        teamId: TEAM,
        mcpBaseUrl: null,
        nudge: createNudgeQueue(),
        abortMap: new Map(),
        onEvent: (sk, ev, run) => engine.onEvent(sk, ev, run),
        onSessionClosed: (sk, run) => engine.onSessionClosed(sk, run),
        takeHeldReportUps: (sk, taskId) => engine.takeHeldReportUps(sk, taskId),
        taskForSession: (sk) => engine.taskForSession(sk),
        execForSession: (sk) => engine.execForSession(sk),
        stopGen: () => 0,
        leaderAgentId: () => LEAD,
        persistTurn: () => undefined,
        makeAdapterForAgent: (agentId) => adapters.get(agentId) ?? null,
      })
      await deliver(skFor(LEAD), LEAD, 'hello', { kind: 'human' })
      await settle(() => started(lead).length === 1 && outbox.held().length === 0, 'the lead run')
      expect(started(lead)[0]!.context).toContain('the fix is in')
      expect(started(lead)[0]!.message).toBe('hello')
      expect(outbox.pending()).toEqual([])
      expect(outbox.held()).toEqual([])
      expect(id).toBeTruthy()
    })
  })

  describe('a restart', () => {
    it('between a wake and its run still delivers it, once', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      // The reply saved the wake and the process died before any run started.
      await reply(task.id, 'first thing tomorrow', { dispatch: () => undefined })
      vi.clearAllTimers()
      script([done('did it')])
      proc = bootProcess(db, adapters)
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the restart')
      expect(started()).toHaveLength(1)
      expect(started()[0]!.context).toContain('first thing tomorrow')
      pumpTaskWakes(db, pumpDeps())
      await vi.advanceTimersByTimeAsync(10_000)
      expect(started()).toHaveLength(1)
      expect(allWakes().map((w) => w.settledHow)).toEqual(['delivered'])
    })

    describe("a hand-off a replay repeats, in the same words on the same session's run id", () => {
      const handOff = {
        kind: 'tool-call',
        name: 'clawboo-teamchat.team_delegate',
        input: { assignee: 'Other', task: 'write the docs' },
        partial: false,
      } as unknown as RuntimeEvent
      const handedOff = (): DbTask[] =>
        listTasks(db, { teamId: TEAM }).filter((t) => t.title === 'write the docs') as DbTask[]

      it('is a new delivery, so work that finished is handed off again', async () => {
        const task = newTask()
        updateStatus(db, task.id, 'blocked')
        adapters.set(OTHER, new ScriptedAdapter([[done('docs written')], [done('written again')]]))
        script(
          [handOff, fatal('provider said no')],
          [handOff, done('finished it')],
          [done('all of it is in')],
        )
        await reply(task.id, 'please finish this')
        await settle(() => handedOff()[0]?.status === 'done', 'the first hand-off')
        await settle(() => allWakes()[0]?.replays === 1, 'the failed run to give the wake back')
        pumpTaskWakes(db, pumpDeps())
        await settle(() => handedOff().length === 2, 'the replay to hand it off again')
        // It handed work out, so it is done after the turn it gets when that work is in.
        await settle(() => getTask(db, task.id)?.status === 'done', 'the follow-up')
        expect(allWakes().map((w) => w.settledHow)).toEqual(['delivered', 'delivered'])
      })

      it('finds work still open and says so, instead of swallowing it as a replay', async () => {
        const task = newTask()
        updateStatus(db, task.id, 'blocked')
        adapters.set(OTHER, new ScriptedAdapter([['hang']]))
        script([handOff, fatal('provider said no')], [handOff, done('finished it')])
        await reply(task.id, 'please finish this')
        await settle(() => handedOff()[0]?.status === 'in_progress', 'the first hand-off')
        await settle(() => allWakes()[0]?.replays === 1, 'the failed run to give the wake back')
        pumpTaskWakes(db, pumpDeps())
        // That work is its own sub-task, still going, so the task waits for it, and the
        // note that it was found waits with the results for the task's next run.
        await settle(() => getTask(db, task.id)?.status === 'blocked', 'the replay to end')
        expect(parseWaitingOn(getTask(db, task.id)?.waitingOn)?.kind).toBe('subtasks')
        expect(
          listPendingReportUps(db, TEAM, null).some((r) => /"already_open"/.test(r.payload)),
        ).toBe(true)
        expect(handedOff()).toHaveLength(1)
      })
    })

    it('during the run that carried it sends it again on the next run, once', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      script(['hang'])
      await reply(task.id, 'please finish this')
      await settle(() => started().length === 1, 'the first run')
      expect(allWakes()[0]!.carriedExecId).not.toBeNull()
      // The server dies. Its beats stop, and boot reaps the run.
      vi.clearAllTimers()
      db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, task.id)).run()
      expect(reconcileOrphans(db, { staleAfterMs: 1_000 }).reconciled).toBe(1)
      const again = allWakes()[0]!
      expect(again.carriedExecId).toBeNull()
      expect(again.replays).toBe(1)
      script([done('finished it')])
      proc = bootProcess(db, adapters)
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the replay')
      expect(started()).toHaveLength(1)
      expect(started()[0]!.context).toContain('please finish this')
      expect(allWakes().map((w) => w.settledHow)).toEqual(['delivered'])
    })
  })

  describe('a failed run that carried a comment', () => {
    it('goes back to waiting and is started again, within the replay count', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      script([fatal('provider exploded')])
      await reply(task.id, 'once more')
      await settle(() => getTask(db, task.id)?.status === 'blocked', 'the failed run')
      const [row] = listWaitingTaskWakes(db)
      expect(row!.replays).toBe(1)
      script([done('recovered')])
      proc = bootProcess(db, adapters)
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the replay')
      expect(started()[0]!.context).toContain('once more')
    })

    it('a sign-in refusal stays parked: the comment waits for a person to fix it', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      script([fatal('invalid api key', 'authentication_failed')])
      await reply(task.id, 'go')
      await settle(() => getTask(db, task.id)?.status === 'blocked', 'the refused run')
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().includes('sign_in'), 'the skip note')
      expect(getTask(db, task.id)?.status).toBe('blocked')
      expect(listWaitingTaskWakes(db)).toHaveLength(1)
    })
  })

  describe('a run the host refused for a hard budget', () => {
    it('is filed as a refusal, not counted, and its comment stays waiting', async () => {
      const task = newTask()
      const exec = claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      expect(exec.ok).toBe(true)
      const claimed = exec.execution!
      await reply(task.id, 'over the cap?')
      const board = createServerBoardClient(db)
      // What the engine writes for a refused start.
      await board.updateStatus(task.id, 'blocked')
      await board.completeExecution(claimed.id, {
        status: 'failed',
        error: 'The team budget is paused at its hard cap.',
        errorClass: 'BudgetRefused',
      })
      const row = listExecutions(db, task.id)[0]!
      expect(row.errorClass).toBe('BudgetRefused')
      expect(row.madeProgress).toBeNull()
      expect(listWaitingTaskWakes(db)[0]!.replays).toBe(0)
    })
  })

  describe('what a person did on the board', () => {
    /** A task its agent asked about, as `ask_person` leaves it. */
    const asking = (prompt = 'Deploy?'): { task: DbTask; questionId: string } => {
      const task = newTask()
      claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      const exec = listExecutions(db, task.id).at(-1)!
      const asked = askQuestion(db, {
        taskId: task.id,
        agentId: WORKER,
        kind: 'confirm',
        payload: { prompt },
      })
      if (!asked.ok) throw new Error(`ask refused: ${asked.reason}`)
      completeExecutionProcess(db, exec.id, { status: 'succeeded' })
      return { task: getTask(db, task.id)!, questionId: asked.question.id }
    }
    /** What the answer route commits: the answer, its comments and its wake. */
    const answer = (questionId: string, words = 'No.'): string => {
      const result = answerQuestion(db, questionId, { confirmed: false }, { person: LOCAL_PERSON })
      if (!result.ok) throw new Error(`answer refused: ${result.reason}`)
      const written = addComment(db, result.task.id, words, 'user', null, { kind: 'person' })
      const saved = savePersonWake(db, result.task, 'question_answered', {
        id: written.id,
        body: words,
      })
      if (!saved.saved) throw new Error('no wake saved')
      return saved.agentId
    }

    describe('during a pause', () => {
      const pause = (): void => {
        placePause(db, { kind: 'agent', id: WORKER })
      }
      const resume = (): void => {
        liftPause(db, 'agent', WORKER)
      }
      const NOTE = 'Stopped: this agent is paused. The task starts again on resume.'

      it('an answer saves its wake, says so, and goes out on resume, once', async () => {
        const { task, questionId } = asking()
        pause()
        const agentId = answer(questionId)

        expect(startPersonWake(db, task.id, agentId, pumpDeps())).toEqual({
          status: 'queued',
          agentId: WORKER,
          reason: 'paused',
        })
        pumpTaskWakes(db, pumpDeps())
        expect(getTask(db, task.id)?.status).toBe('blocked')
        expect(started()).toEqual([])
        expect(listWaitingTaskWakes(db)[0]).toMatchObject({
          reason: 'question_answered',
          skipReason: 'paused',
          replays: 0,
        })

        resume()
        script([done('did it another way')])
        pumpTaskWakes(db, pumpDeps())
        pumpTaskWakes(db, pumpDeps())
        await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the resume')
        expect(started()).toHaveLength(1)
        expect(started()[0]!.context).toContain('Why this run: a person answered your question')
      })

      it('a Reopen saves its wake, says so, and starts on resume, past a Stop', async () => {
        const task = newTask()
        const c = claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
        completeExecutionProcess(db, c.execution!.id, { status: 'cancelled', byPerson: true })
        updateStatus(db, task.id, 'cancelled', { actor: 'person' })
        pause()

        expect(reopenTask(db, task.id).ok).toBe(true)
        const note = personComment(task.id, 'Use the new logo this time')
        const saved = savePersonWake(db, getTask(db, task.id)!, 'reopened', {
          id: note.id,
          body: 'Use the new logo this time',
        })
        if (!saved.saved) throw new Error('no wake saved')
        expect(startPersonWake(db, task.id, saved.agentId, pumpDeps())).toMatchObject({
          status: 'queued',
          reason: 'paused',
        })
        expect(getTask(db, task.id)?.status).toBe('todo')
        expect(started()).toEqual([])

        resume()
        script([done('used it')])
        pumpTaskWakes(db, pumpDeps())
        await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the resume')
        expect(started()).toHaveLength(1)
        expect(started()[0]!.context).toContain('Use the new logo this time')
      })

      it('a reply to a hand-back gives the turn back, and the agent starts on resume', async () => {
        const task = newTask()
        const c = claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
        expect(handBackTask(db, task.id, { agentId: WORKER, need: 'Log in' }).ok).toBe(true)
        completeExecutionProcess(db, c.execution!.id, { status: 'succeeded' })
        pause()

        expect(await reply(task.id, 'Logged in, carry on')).toMatchObject({ reason: 'paused' })
        expect(getTask(db, task.id)?.status).toBe('blocked')
        expect(started()).toEqual([])

        resume()
        script([done('carried on')])
        pumpTaskWakes(db, pumpDeps())
        await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the resume')
        expect(started()[0]!.context).toContain('Logged in, carry on')
      })

      it('a resume never fires a person’s task, whatever wake waits on it', async () => {
        const task = newTask()
        claimTask(db, task.id, WORKER)
        expect(handBackTask(db, task.id, { agentId: WORKER, need: 'Log in' }).ok).toBe(true)
        recordTaskWake(db, {
          teamId: TEAM,
          agentId: WORKER,
          taskId: task.id,
          reason: 'person_comment',
          commentIds: ['earlier'],
        })
        pause()
        pumpTaskWakes(db, pumpDeps())

        resume()
        pumpTaskWakes(db, pumpDeps())
        void proc.engine.resume()
        await vi.advanceTimersByTimeAsync(STEER_BATCH_MS + 100)

        expect(skips()).toEqual(['paused', 'person_assigned'])
        expect(started()).toEqual([])
        expect(getTask(db, task.id)).toMatchObject({ status: 'blocked' })
        expect(getTask(db, task.id)?.assigneePersonId).not.toBeNull()
      })

      it('a comment written after its agent asked starts the task on resume, as it does with no pause', async () => {
        const { task } = asking()
        pause()
        expect(await reply(task.id, 'Skip the deploy, ship it Friday.')).toEqual({
          status: 'queued',
          agentId: WORKER,
          reason: 'paused',
        })
        pumpTaskWakes(db, pumpDeps())
        expect(getTask(db, task.id)?.status).toBe('blocked')
        expect(started()).toEqual([])

        script([done('shipped it')])
        resume()
        pumpTaskWakes(db, pumpDeps())
        await settle(() => getTask(db, task.id)?.status === 'done', 'the run the comment started')
        expect(started()).toHaveLength(1)
        expect(listTaskQuestions(db, task.id).map((q) => q.status)).not.toContain('pending')
      })

      it('a comment from before its agent asked still waits for the answer', async () => {
        const task = newTask()
        claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
        const exec = listExecutions(db, task.id).at(-1)!
        const comment = personComment(task.id, 'Use the staging database.')
        recordTaskWake(db, {
          teamId: TEAM,
          agentId: WORKER,
          taskId: task.id,
          reason: 'person_comment',
          commentIds: [comment.id],
        })
        await vi.advanceTimersByTimeAsync(1_000)
        const asked = askQuestion(db, {
          taskId: task.id,
          agentId: WORKER,
          kind: 'confirm',
          payload: { prompt: 'Deploy?' },
        })
        if (!asked.ok) throw new Error(`ask refused: ${asked.reason}`)
        completeExecutionProcess(db, exec.id, { status: 'succeeded' })

        pumpTaskWakes(db, pumpDeps())
        expect(getTask(db, task.id)?.status).toBe('blocked')
        expect(started()).toEqual([])
        expect(listWaitingTaskWakes(db)[0]).toMatchObject({ skipReason: 'question' })
      })

      it('a run it stops keeps the question its agent asked: no failure, no note, no restart', async () => {
        const task = newTask()
        let questionId = ''
        script(
          [
            () => {
              const asked = askQuestion(db, {
                taskId: task.id,
                agentId: WORKER,
                kind: 'confirm',
                payload: { prompt: 'Deploy?' },
              })
              if (!asked.ok) throw new Error(`ask refused: ${asked.reason}`)
              questionId = asked.question.id
              pause()
              void proc.engine.pauseRuns(() => true, NOTE)
            },
            'advance',
            { kind: 'done', reason: 'aborted', summary: '' } as RuntimeEvent,
          ],
          [done('did it another way')],
        )
        void proc.engine.dispatchTask(task.id)
        await settle(
          () => listExecutions(db, task.id).at(-1)?.errorClass === PAUSED_RUN_CLASS,
          'the pause to close the run',
        )
        await vi.advanceTimersByTimeAsync(STEER_BATCH_MS + 100)

        const row = getTask(db, task.id)!
        expect(row.status).toBe('blocked')
        expect(parseWaitingOn(row.waitingOn)).toMatchObject({ kind: 'question', questionId })
        expect(listTaskQuestions(db, task.id).map((q) => q.status)).toEqual(['pending'])
        expect(attentionForTask(db, task.id)).toMatchObject({ reason: 'question' })
        expect(getComments(db, task.id).map((c) => c.body)).not.toContain(NOTE)

        // The resume starts nothing: the question is still theirs to answer.
        resume()
        pumpTaskWakes(db, pumpDeps())
        void proc.engine.resume()
        await vi.advanceTimersByTimeAsync(STEER_BATCH_MS + 100)
        expect(started()).toHaveLength(1)
        expect(getTask(db, task.id)?.status).toBe('blocked')

        answer(questionId)
        pumpTaskWakes(db, pumpDeps())
        await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the answer')
        expect(started()).toHaveLength(2)
      })
    })

    it('an answer wakes through a saved wake, and a restart loses nothing', async () => {
      const { task, questionId } = asking()
      // The server dies right after the answer's write: nothing started anything.
      answer(questionId)
      const [row] = listWaitingTaskWakes(db)
      expect(row?.reason).toBe('question_answered')
      expect(wakeCommentIds(row!)).toHaveLength(1)
      expect(getTask(db, task.id)?.status).toBe('blocked')

      // A restart: all that is left is the database, and the pump's first pass.
      vi.clearAllTimers()
      proc = bootProcess(db, adapters)
      script([done('did it another way')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the restart')

      expect(started().at(-1)!.context).toContain('Why this run: a person answered your question')
      expect(started().at(-1)!.context).toMatch(/from=person[^\n]*\n\| No\./)
      expect(allWakes().map((w) => w.settledHow)).toEqual(['delivered'])
      expect(listExecutions(db, task.id).at(-1)?.runReason).toBe('question_answered')
      expect(
        getComments(db, task.id).some((c) => c.body === 'Started again with a person’s answer.'),
      ).toBe(true)
    })

    it('an answer while the asking run is still ending waits for it, then goes', async () => {
      const task = newTask()
      claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      const exec = listExecutions(db, task.id).at(-1)!
      const asked = askQuestion(db, {
        taskId: task.id,
        agentId: WORKER,
        kind: 'confirm',
        payload: { prompt: 'Deploy?' },
      })
      if (!asked.ok) throw new Error('ask refused')
      const agentId = answer(asked.question.id)

      expect(startPersonWake(db, task.id, agentId, pumpDeps())).toMatchObject({
        status: 'queued',
        reason: 'next-run',
      })
      expect(getTask(db, task.id)?.status).toBe('blocked')
      expect(started()).toEqual([])

      completeExecutionProcess(db, exec.id, { status: 'succeeded' })
      script([done('carried on')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run after it ended')
      expect(allWakes().map((w) => w.settledHow)).toEqual(['delivered'])
    })

    it('a reply to a hand-back while its run is still ending waits for it, then goes', async () => {
      const task = newTask()
      claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      const exec = listExecutions(db, task.id).at(-1)!
      expect(handBackTask(db, task.id, { agentId: WORKER, need: 'Log in' }).ok).toBe(true)

      expect(await reply(task.id, 'Logged in, carry on')).toMatchObject({
        status: 'queued',
        reason: 'next-run',
      })
      expect(getTask(db, task.id)?.status).toBe('blocked')
      expect(started()).toEqual([])

      completeExecutionProcess(db, exec.id, { status: 'succeeded' })
      script([done('carried on')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run after it ended')
      expect(started().at(-1)!.context).toContain('Logged in, carry on')
    })

    it('a Reopen with a note reaches the agent through the wake', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'cancelled', { actor: 'person' })
      expect(reopenTask(db, task.id).ok).toBe(true)
      const note = personComment(task.id, 'Use the new logo this time')
      const saved = savePersonWake(db, getTask(db, task.id)!, 'reopened', {
        id: note.id,
        body: 'Use the new logo this time',
      })
      if (!saved.saved) throw new Error('no wake saved')
      expect(wakeCommentIds(listWaitingTaskWakes(db)[0]!)).toEqual([note.id])

      script([done('used it')])
      expect(startPersonWake(db, task.id, saved.agentId, pumpDeps()).status).toBe('woke-agent')
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')

      expect(started().at(-1)!.context).toContain('Why this run: a person reopened this task')
      expect(started().at(-1)!.context).toContain('Use the new logo this time')
      expect(allWakes().map((w) => w.settledHow)).toEqual(['delivered'])
    })

    it('a Reopen starts past a ledger that ended in a Stop, and only once', async () => {
      const task = newTask()
      const c = claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      completeExecutionProcess(db, c.execution!.id, { status: 'cancelled', byPerson: true })
      updateStatus(db, task.id, 'cancelled', { actor: 'person' })
      expect(reopenTask(db, task.id).ok).toBe(true)
      const saved = savePersonWake(db, getTask(db, task.id)!, 'reopened', null)
      if (!saved.saved) throw new Error('no wake saved')
      script([done('again')])
      expect(startPersonWake(db, task.id, saved.agentId, pumpDeps()).status).toBe('woke-agent')
      // The pass the wake's own event brings finds nothing more to do.
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started()).toHaveLength(1)
    })

    it('the pump never fires a person’s task, whatever wake waits on it', async () => {
      const task = newTask()
      claimTask(db, task.id, WORKER)
      expect(handBackTask(db, task.id, { agentId: WORKER, need: 'Log in' }).ok).toBe(true)
      // Someone's comment from before the hand-back is still waiting for a turn.
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'person_comment',
        commentIds: ['earlier'],
      })
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['person_assigned'])
      expect(getTask(db, task.id)?.status).toBe('blocked')
      expect(getTask(db, task.id)?.assigneePersonId).not.toBeNull()
      expect(started()).toEqual([])
      expect(listWaitingTaskWakes(db)).toHaveLength(1)
    })

    it('the pump never ends a wait on a question, and the answer carries what waited', async () => {
      const { task, questionId } = asking()
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'person_comment',
        commentIds: ['earlier'],
      })
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['question'])
      expect(getTask(db, task.id)?.status).toBe('blocked')
      expect(listTaskQuestions(db, task.id).map((q) => q.status)).toEqual(['pending'])
      expect(started()).toEqual([])

      answer(questionId)
      const rows = listWaitingTaskWakes(db)
      expect(rows).toHaveLength(1)
      expect(wakeCommentIds(rows[0]!)).toHaveLength(2)
      script([done('heard it all')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started()).toHaveLength(1)
    })

    it('a brake does not lose an answer: it waits, then goes out', async () => {
      const { task, questionId } = asking()
      answer(questionId)
      // Two runs carrying it died with nothing to show, so the brake is on.
      updateStatus(db, task.id, 'todo')
      for (let i = 0; i < 2; i++) {
        const c = claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
        expect(c.ok).toBe(true)
        db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, task.id)).run()
        expect(reconcileStaleInProgress(db, 1_000).reconciled).toBe(1)
      }
      expect(listWaitingTaskWakes(db)[0]!.replays).toBe(2)
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().includes('braked'), 'the brake holding it back')
      expect(started()).toEqual([])
      expect(wakeCommentIds(listWaitingTaskWakes(db)[0]!)).toHaveLength(1)

      // The brake's wait runs out: it reads the time the last run ended.
      db.update(executionProcesses)
        .set({ completedAt: Date.now() - 31 * 60_000 })
        .where(eq(executionProcesses.taskId, task.id))
        .run()
      script([done('finally')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run after the brake')
      expect(started()[0]!.context).toMatch(/from=person[^\n]*\n\| No\./)
      expect(allWakes().map((w) => w.settledHow)).toEqual(['delivered'])
    })
  })

  describe('an agent’s comment on a teammate’s task', () => {
    /** The worker's task, parked on what it says it needs, its run over. */
    const parked = (): DbTask => {
      const task = newTask()
      const c = claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      completeExecutionProcess(db, c.execution!.id, { status: 'succeeded' })
      updateStatus(db, task.id, 'blocked', {
        waitingOn: { kind: 'person', need: 'The key', by: 'agent' },
      })
      return getTask(db, task.id)!
    }
    /** What `add_comment` does for a bound session. */
    const teammateSays = (taskId: string, body = 'Here is the key', from = OTHER) =>
      saveAgentCommentWake(
        db,
        taskId,
        addComment(db, taskId, body, 'agent', from, { kind: 'agent' }),
      )
    const card = (taskId: string) => attentionForTask(db, taskId)?.agentWakes

    it('starts nothing until a person says yes, and the card asks once', async () => {
      const task = parked()
      expect(teammateSays(task.id)).toMatchObject({ state: 'saved', agentId: WORKER })
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['ask_once'])
      expect(started()).toEqual([])
      expect(getTask(db, task.id)?.status).toBe('blocked')
      expect(card(task.id)).toMatchObject({
        jobTaskId: task.id,
        kind: 'ask',
        fromAgentId: OTHER,
        toAgentId: WORKER,
      })

      // A restart resets nothing: the card and the wake are both still there.
      vi.clearAllTimers()
      proc = bootProcess(db, adapters)
      pumpTaskWakes(db, pumpDeps())
      await vi.advanceTimersByTimeAsync(5_000)
      expect(started()).toEqual([])
      expect(card(task.id)?.kind).toBe('ask')

      // Yes on this job: the wake goes, and says why.
      expect(decideAgentWakes(db, task.id, 'job', LOCAL_PERSON).ok).toBe(true)
      script([done('used the key')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started()).toHaveLength(1)
      expect(started()[0]!.context).toContain('Why this run: a teammate commented on this task')
      expect(started()[0]!.context).toContain('Here is the key')
      expect(listExecutions(db, task.id).at(-1)?.runReason).toBe('agent_comment')
      expect(allWakes().map((w) => w.settledHow)).toEqual(['delivered'])
      expect(readAgentWakeGate(db, task.id)?.windowCount).toBe(1)
      expect(
        getComments(db, task.id).some((c) => c.body === 'Started again for a teammate’s comment.'),
      ).toBe(true)
    })

    it('after a yes the job’s other tasks go without asking, and another job still asks', async () => {
      const root = newTask({ title: 'The job', sourceDelegationId: null })
      const first = newTask({ title: 'One part', parentTaskId: root.id })
      const second = newTask({ title: 'Other part', parentTaskId: root.id })
      const elsewhere = newTask({ title: 'Another job' })
      for (const t of [first, second, elsewhere]) {
        const c = claimTask(db, t.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
        completeExecutionProcess(db, c.execution!.id, { status: 'succeeded' })
        updateStatus(db, t.id, 'blocked', {
          waitingOn: { kind: 'person', need: 'x', by: 'agent' },
        })
      }
      teammateSays(first.id)
      pumpTaskWakes(db, pumpDeps())
      expect(card(first.id)?.jobTaskId).toBe(root.id)
      expect(decideAgentWakes(db, root.id, 'job', LOCAL_PERSON).ok).toBe(true)

      teammateSays(second.id)
      teammateSays(elsewhere.id)
      script([done('one')], [done('two')])
      pumpTaskWakes(db, pumpDeps())
      await settle(
        () => getTask(db, first.id)?.status === 'done' && getTask(db, second.id)?.status === 'done',
        'both parts',
      )
      expect(card(second.id)).toBeUndefined()
      expect(getTask(db, elsewhere.id)?.status).toBe('blocked')
      expect(card(elsewhere.id)?.kind).toBe('ask')
    })

    it('a no closes it, starts nothing, and is not asked again on this job', async () => {
      const task = parked()
      teammateSays(task.id)
      pumpTaskWakes(db, pumpDeps())
      expect(decideAgentWakes(db, task.id, 'no', LOCAL_PERSON).ok).toBe(true)
      expect(listWaitingTaskWakes(db)).toEqual([])
      expect(allWakes().map((w) => w.settledHow)).toEqual(['declined'])
      expect(card(task.id)).toBeUndefined()

      expect(teammateSays(task.id, 'Again')).toEqual({ state: 'declined', agentId: WORKER })
      pumpTaskWakes(db, pumpDeps())
      await vi.advanceTimersByTimeAsync(5_000)
      expect(started()).toEqual([])
      expect(card(task.id)).toBeUndefined()

      // A person's comment still wakes at once, and reads what was said.
      script([done('heard')])
      expect((await reply(task.id, 'Carry on')).status).toBe('woke-agent')
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started()[0]!.context).toContain('Again')
    })

    it('a person’s comment wakes at once while the card waits, and carries what waited', async () => {
      const task = parked()
      teammateSays(task.id)
      pumpTaskWakes(db, pumpDeps())
      expect(card(task.id)?.kind).toBe('ask')
      script([done('heard')])
      expect((await reply(task.id, 'Carry on')).status).toBe('woke-agent')
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started()).toHaveLength(1)
      expect(started()[0]!.context).toContain('Here is the key')
      expect(listExecutions(db, task.id).at(-1)?.runReason).toBe('person_comment')
    })

    it('the team’s always needs no card', async () => {
      const task = parked()
      setTeamAlwaysAllow(db, TEAM, true)
      teammateSays(task.id)
      script([done('used it')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(skips()).toEqual([])
      expect(card(task.id)).toBeUndefined()
    })

    it('pauses at the hourly cap and says so, through a restart, until the hour is over', async () => {
      const task = parked()
      setTeamAlwaysAllow(db, TEAM, true)
      for (let i = 0; i < MAX_AGENT_WAKES_PER_HOUR; i++)
        noteAgentWakeStarted(db, task.id, { fromAgentId: OTHER, toAgentId: WORKER })
      teammateSays(task.id)
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['hourly_cap'])
      expect(card(task.id)?.kind).toBe('hourly_cap')

      vi.clearAllTimers()
      proc = bootProcess(db, adapters)
      pumpTaskWakes(db, pumpDeps())
      await vi.advanceTimersByTimeAsync(5_000)
      expect(started()).toEqual([])

      // The hour ends: it goes by itself, and the card comes down.
      db.update(agentWakeGates)
        .set({ windowStartedAt: Date.now() - AGENT_WAKE_WINDOW_MS })
        .where(eq(agentWakeGates.jobTaskId, task.id))
        .run()
      expect(card(task.id)).toBeUndefined()
      script([done('used it')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(readAgentWakeGate(db, task.id)?.cardKind).toBeNull()
      expect(readAgentWakeGate(db, task.id)?.windowCount).toBe(1)
    })

    it('stops a back-and-forth and shows it, until a person steps in', async () => {
      const task = parked()
      setTeamAlwaysAllow(db, TEAM, true)
      for (let i = 0; i < MAX_BACK_AND_FORTH; i++)
        noteAgentWakeStarted(
          db,
          task.id,
          i % 2 === 0
            ? { fromAgentId: OTHER, toAgentId: WORKER }
            : { fromAgentId: WORKER, toAgentId: OTHER },
        )
      teammateSays(task.id, 'Your turn again')
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['back_and_forth'])
      expect(started()).toEqual([])
      expect(card(task.id)).toMatchObject({ kind: 'back_and_forth', toAgentId: WORKER })

      script([done('heard')])
      expect((await reply(task.id, 'Enough, do this')).status).toBe('woke-agent')
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(readAgentWakeGate(db, task.id)?.cardKind).toBeNull()
      expect(
        agentWakeVerdictFor(db, task.id, { fromAgentId: WORKER, toAgentId: OTHER }, Date.now()),
      ).toBe('allowed')
    })

    it('a stopped pair stays stopped after an hour of quiet, until a person answers', async () => {
      const task = parked()
      setTeamAlwaysAllow(db, TEAM, true)
      for (let i = 0; i < MAX_BACK_AND_FORTH; i++)
        noteAgentWakeStarted(
          db,
          task.id,
          i % 2 === 0
            ? { fromAgentId: OTHER, toAgentId: WORKER }
            : { fromAgentId: WORKER, toAgentId: OTHER },
        )
      teammateSays(task.id, 'Your turn again')
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['back_and_forth'])
      const later = Date.now() + 3 * 60 * 60_000
      pumpTaskWakes(db, pumpDeps({ now: () => later }))
      await new Promise((resolve) => setImmediate(resolve))
      expect(skips()).toEqual(['back_and_forth'])
      expect(started()).toEqual([])
    })

    it('a wake that brings a task back keeps the check it failed', async () => {
      const task = parked()
      setTeamAlwaysAllow(db, TEAM, true)
      db.update(tasks)
        .set({ verification: JSON.stringify({ status: 'fail', attempts: [{}] }) })
        .where(eq(tasks.id, task.id))
        .run()
      teammateSays(task.id, 'I found it')
      script([done('on it')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => started().length > 0, 'the run')
      expect(
        db.select({ v: tasks.verification }).from(tasks).where(eq(tasks.id, task.id)).get()?.v,
      ).toContain('"status":"fail"')
    })

    it('a job at its limit holds a teammate’s wake, and starts nothing', async () => {
      const task = parked()
      setTeamAlwaysAllow(db, TEAM, true)
      db.insert(jobRuns)
        .values({ jobTaskId: task.id, teamId: TEAM, runs: 3, runLimit: 3, updatedAt: 1 })
        .run()
      teammateSays(task.id, 'I found it')
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['job_limit'])
      expect(started()).toEqual([])
      expect(getTask(db, task.id)?.status).toBe('blocked')
    })

    it('a job a person stopped says so, and raises no card', async () => {
      const task = parked()
      setTeamAlwaysAllow(db, TEAM, true)
      db.insert(jobRuns)
        .values({
          jobTaskId: task.id,
          teamId: TEAM,
          runs: 3,
          runLimit: 3,
          stoppedAt: 1,
          updatedAt: 1,
        })
        .run()
      teammateSays(task.id, 'I found it')
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['job_stopped'])
      expect(started()).toEqual([])
      expect(jobLimitedTaskIds(db)).toEqual([])
    })

    it('a person’s comment still goes in a job they stopped, and ends the stop', async () => {
      const task = parked()
      db.insert(jobRuns)
        .values({
          jobTaskId: task.id,
          teamId: TEAM,
          runs: 3,
          runLimit: 3,
          stoppedAt: 1,
          updatedAt: 1,
        })
        .run()
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'person_comment',
      })
      script([done('on it')])
      pumpTaskWakes(db, pumpDeps())
      await settle(() => started().length > 0, 'the run')
      expect(jobRunStopped(db, task.id)).toBe(false)
      expect(jobRunState(db, task.id).runs).toBe(3)
    })

    it('one pass pumps each room once, however many of its wakes it found', () => {
      for (const title of ['one', 'two', 'three']) {
        const t = newTask({ title })
        recordTaskWake(db, {
          teamId: TEAM,
          agentId: WORKER,
          taskId: t.id,
          reason: 'dependency_done',
        })
      }
      const pumps: string[] = []
      pumpTaskWakesByRoom(
        db,
        (pumpRoom) => pumpDeps({ pumpRoom }),
        (teamId, roomId) => pumps.push(`${teamId}/${roomId}`),
      )
      expect(pumps).toEqual([`${TEAM}/null`])
    })

    it('asks the budget gate once a pass for one agent’s job, however many wakes wait', () => {
      const root = newTask({ title: 'The job' })
      for (const title of ['one', 'two', 'three']) {
        const sub = createSubtask(db, root.id, {
          title,
          status: 'todo',
          sourceDelegationId: `r0:deleg:agent:${WORKER}:reflectTo:${LEAD}`,
        })
        recordTaskWake(db, {
          teamId: TEAM,
          agentId: WORKER,
          taskId: sub.id,
          reason: 'dependency_done',
        })
      }
      let asked = 0
      pumpTaskWakes(
        db,
        pumpDeps({
          budgetRefuses: () => {
            asked += 1
            return true
          },
        }),
      )
      expect(asked).toBe(1)
    })

    it('holds across jobs: two agents answering each other on two tasks stop too', async () => {
      const mine = parked()
      setTeamAlwaysAllow(db, TEAM, true)
      const theirs = newTask({
        title: 'Their task',
        sourceDelegationId: `r0:deleg:agent:${OTHER}:reflectTo:${LEAD}`,
      })
      // Each job only ever saw one direction, and two of its wakes.
      for (let i = 0; i < MAX_BACK_AND_FORTH; i++)
        noteAgentWakeStarted(
          db,
          i % 2 === 0 ? mine.id : theirs.id,
          i % 2 === 0
            ? { fromAgentId: OTHER, toAgentId: WORKER }
            : { fromAgentId: WORKER, toAgentId: OTHER },
        )
      teammateSays(mine.id, 'Your turn again')
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['back_and_forth'])
      expect(started()).toEqual([])
      expect(card(mine.id)?.kind).toBe('back_and_forth')
    })

    it('a run that took the wake and failed shows the failure, not a stale card', async () => {
      const task = parked()
      teammateSays(task.id)
      pumpTaskWakes(db, pumpDeps())
      expect(card(task.id)?.kind).toBe('ask')
      // A person's Retry: its run takes the wake, and that run fails.
      updateStatus(db, task.id, 'todo')
      script([{ kind: 'done', reason: 'error', summary: 'boom' } as RuntimeEvent])
      await proc.engine.dispatchTask(task.id)
      await settle(() => getTask(db, task.id)?.status === 'blocked', 'the failed run')
      expect(attentionForTask(db, task.id)?.reason).toBe('failed')
      expect(card(task.id)).toBeUndefined()
      // The wake came back, and it does not raise a card on a failed task.
      pumpTaskWakes(db, pumpDeps())
      await vi.advanceTimersByTimeAsync(2_000)
      expect(attentionForTask(db, task.id)?.reason).toBe('failed')
    })

    it('one ask for a fan-out: the answer covers every task waiting on it', async () => {
      const first = parked()
      const second = parked()
      teammateSays(first.id)
      teammateSays(second.id)
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().filter((s) => s === 'ask_once').length === 2, 'both skip notes')
      expect(card(first.id)?.alsoWaiting).toBe(1)
      expect(card(second.id)).toBeUndefined()
      const answered = decideAgentWakes(db, first.id, 'job', LOCAL_PERSON)
      expect(answered.ok).toBe(true)
      script([done('one')], [done('two')])
      pumpTaskWakes(db, pumpDeps())
      await settle(
        () => getTask(db, first.id)?.status === 'done' && getTask(db, second.id)?.status === 'done',
        'both tasks',
      )
    })

    it('a budget cap comes before asking: no card over a wake that could not start', async () => {
      const task = parked()
      teammateSays(task.id)
      pumpTaskWakes(db, pumpDeps({ budgetRefuses: () => true }))
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['budget'])
      expect(card(task.id)).toBeUndefined()
      expect(readAgentWakeGate(db, task.id)?.cardKind ?? null).toBeNull()
      // The cap is raised: now it asks.
      pumpTaskWakes(db, pumpDeps({ budgetRefuses: () => false }))
      expect(card(task.id)?.kind).toBe('ask')
    })

    it('a budget cap comes before the pauses too', async () => {
      const task = parked()
      setTeamAlwaysAllow(db, TEAM, true)
      for (let i = 0; i < MAX_AGENT_WAKES_PER_HOUR; i++)
        noteAgentWakeStarted(db, task.id, { fromAgentId: OTHER, toAgentId: WORKER })
      teammateSays(task.id)
      pumpTaskWakes(db, pumpDeps({ budgetRefuses: () => true }))
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['budget'])
      expect(card(task.id)).toBeUndefined()
    })

    it('a comment on a task waiting on its sub-tasks wakes nothing, and the wait stands', async () => {
      const parent = newTask({ title: 'The parent' })
      claimTask(db, parent.id, WORKER, 'codex', { run: { executorType: 'openclaw' } })
      completeExecutionProcess(db, listExecutions(db, parent.id).at(-1)!.id, {
        status: 'succeeded',
      })
      const sub = newTask({ title: 'A part', parentTaskId: parent.id })
      updateStatus(db, parent.id, 'blocked', { waitingOn: { kind: 'subtasks' } })
      expect(teammateSays(parent.id)).toEqual({ state: 'none' })
      pumpTaskWakes(db, pumpDeps())
      await vi.advanceTimersByTimeAsync(2_000)
      expect(card(parent.id)).toBeUndefined()
      expect(attentionForTask(db, parent.id)).toBeNull()
      expect(parseWaitingOn(getTask(db, parent.id)?.waitingOn)).toEqual({ kind: 'subtasks' })
      // The parent still goes back to the queue when the sub-task is done.
      claimTask(db, sub.id, OTHER, 'codex')
      updateStatus(db, sub.id, 'done')
      expect(getTask(db, parent.id)?.status).toBe('todo')
    })

    describe('on a task the task runner runs', () => {
      const runnerTask = (sourceDelegationId: string | null): DbTask => {
        const task = newTask({ sourceDelegationId })
        setTaskRunnerInputs(db, task.id, {
          runtime: 'codex',
          assigneeAgentId: WORKER,
          repoPath: null,
          kind: null,
          model: null,
        })
        const c = claimTask(db, task.id, WORKER, 'codex', { run: { executorType: 'codex' } })
        completeExecutionProcess(db, c.execution!.id, { status: 'succeeded' })
        updateStatus(db, task.id, 'blocked', {
          waitingOn: { kind: 'person', need: 'The key', by: 'agent' },
        })
        return getTask(db, task.id)!
      }

      it('the run can read the comment: it is in the mailbox, as a teammate’s', () => {
        const task = runnerTask(BOUND)
        teammateSays(task.id)
        const mail = listUndeliveredInbox(db, WORKER, { teamId: TEAM })
        expect(mail.map((r) => r.body).join()).toContain('Here is the key')
      })

      it('with no binding, To do stays put: only a wake that ends a wait starts it', () => {
        const task = runnerTask(null)
        updateStatus(db, task.id, 'todo')
        setTeamAlwaysAllow(db, TEAM, true)
        teammateSays(task.id)
        const startedHere: string[] = []
        pumpTaskWakes(db, pumpDeps({ startForPerson: (t) => startedHere.push(t.id) }))
        expect(startedHere).toEqual([])
      })

      it('with no binding, a yes still starts it: no pump would pick it up', async () => {
        const task = runnerTask(null)
        setTeamAlwaysAllow(db, TEAM, true)
        teammateSays(task.id)
        const startedHere: string[] = []
        pumpTaskWakes(
          db,
          pumpDeps({
            startForPerson: () => {
              throw new Error('a teammate’s wake is no person’s start')
            },
            startByItself: (t) => startedHere.push(t.id),
            pumpRoom: () => {
              throw new Error('the room’s engine does not run this task')
            },
          }),
        )
        expect(getTask(db, task.id)?.status).toBe('todo')
        expect(startedHere).toEqual([task.id])
      })

      it('with a binding, the runner’s own pump starts it', () => {
        const task = runnerTask(BOUND)
        setTeamAlwaysAllow(db, TEAM, true)
        teammateSays(task.id)
        const startedHere: string[] = []
        pumpTaskWakes(db, pumpDeps({ startForPerson: (t) => startedHere.push(t.id) }))
        expect(getTask(db, task.id)?.status).toBe('todo')
        expect(startedHere).toEqual([])
      })
    })

    it('a wait that is not the agent’s to give up: no card, and nothing moves', async () => {
      const task = parked()
      updateStatus(db, task.id, 'blocked', { waitingOn: { kind: 'failure' } })
      teammateSays(task.id)
      pumpTaskWakes(db, pumpDeps())
      await settle(() => skips().length > 0, 'the skip note')
      expect(skips()).toEqual(['blocked'])
      expect(card(task.id)).toBeUndefined()
      expect(started()).toEqual([])
    })

    it('a Stop’s hold and a budget cap both come before asking', async () => {
      const held = parked()
      teammateSays(held.id)
      holdTaskWakes(
        db,
        listWaitingTaskWakes(db).map((w) => w.id),
      )
      pumpTaskWakes(db, pumpDeps())
      await vi.advanceTimersByTimeAsync(2_000)
      expect(card(held.id)).toBeUndefined()
      expect(started()).toEqual([])

      setTeamAlwaysAllow(db, TEAM, true)
      const capped = parked()
      teammateSays(capped.id)
      pumpTaskWakes(db, pumpDeps({ budgetRefuses: () => true }))
      await settle(() => skips().includes('budget'), 'the skip note')
      expect(getTask(db, capped.id)?.status).toBe('blocked')
      expect(started()).toEqual([])
    })

    it('a comment during a run gets no turn before Done: that stays a person’s', async () => {
      const task = newTask()
      script([() => void teammateSays(task.id, 'Too late for this run'), done('finished it')])
      await proc.engine.dispatchTask(task.id)
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started()).toHaveLength(1)
      expect(listExecutions(db, task.id)).toHaveLength(1)
      pumpTaskWakes(db, pumpDeps())
      await settle(() => allWakes().every((w) => w.settledAt !== null), 'the wake to close')
      expect(allWakes().map((w) => w.settledHow)).toEqual(['finished'])
      // Only a person is told that nobody read their comment.
      expect(getComments(db, task.id).some((c) => c.body.includes('finished before'))).toBe(false)
    })
  })

  describe('a task whose team was deleted', () => {
    // What the delete route does to the rows that reference the team.
    const deleteTeam = (): void => {
      db.update(agents).set({ teamId: null }).where(eq(agents.teamId, TEAM)).run()
      db.delete(teams).where(eq(teams.id, TEAM)).run()
    }

    it('its waiting wake is reaped, and no run starts for it', async () => {
      const task = newTask()
      updateStatus(db, task.id, 'blocked')
      recordTaskWake(db, {
        teamId: TEAM,
        agentId: WORKER,
        taskId: task.id,
        reason: 'person_comment',
      })
      deleteTeam()
      const starts: string[] = []
      pumpTaskWakes(
        db,
        pumpDeps({
          startForPerson: (t) => {
            starts.push(t.id)
          },
        }),
      )
      expect(starts).toEqual([])
      expect(allWakes()).toEqual([])
      expect(getTask(db, task.id)?.status).toBe('blocked')
    })

    it('nothing can run it, so a reply or a Retry is told so', () => {
      const task = newTask()
      deleteTeam()
      expect(engineRefusal(db, getTask(db, task.id)!)).toBe('no_team')
    })
  })

  describe('a task a person assigned', () => {
    it('wakes for its comment and reports to no one', async () => {
      const task = newTask({ sourceDelegationId: encodeHumanAssignment(WORKER, 'n1') })
      updateStatus(db, task.id, 'blocked')
      script([done('answered')])
      await reply(task.id, 'one more detail')
      await settle(() => getTask(db, task.id)?.status === 'done', 'the run')
      expect(started(adapters.get(LEAD))).toEqual([])
      expect(started()[0]!.context).toContain('Why this run: a person commented on this task')
    })
  })
})
