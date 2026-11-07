// A task that hands out work waits for it, over the REAL engine, REAL run primitive,
// REAL board and REAL outbox on one temp SQLite file, with scripted adapters, wired the
// way teamOrchestrator wires them. A "process" is one engine + deliver + nudge queue; a
// restart drops it with its timers and builds the next one over the same database.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeHumanAssignment } from '@clawboo/board-core'
import { eq } from 'drizzle-orm'
import {
  addComment,
  agents,
  agentWakeCardsForTasks,
  attentionForTask,
  claimTask,
  createExecutionProcess,
  createSubtask,
  createTask,
  completeExecutionProcess,
  getComments,
  getTask,
  liftPause,
  listEvents,
  listExecutions,
  listPendingReportUps,
  listTasks,
  listWaitingTaskWakes,
  LOCAL_READER,
  markTaskRead,
  placePause,
  reconcileStaleInProgress,
  recordResultClaim,
  releaseFinishedSubtaskWaits,
  saveAgentCommentWake,
  setTaskRunnerInputs,
  startRefusedBy,
  taskReadStates,
  tasks,
  taskWakes,
  teams,
  updateStatus,
  waitingOnDetailOf,
  type ClawbooDb,
  type DbTaskWake,
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
  type EngineBoardClient,
} from '@clawboo/team-orchestration'

import { stopAsOwnWrite } from '../../boardReader'
import { getDb, getDbPath, resetDb } from '../../db'
import { pauseTaskStopNote } from '../../pauseBus'
import { createReportUpOutbox } from '../reportUpOutbox'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'
import { createTaskWakeOutbox, pumpTaskWakes, type TaskWakePumpDeps } from '../taskWakes'
import { settle } from './settleCascade'

const TEAM = 'T'
const LEAD = 'lead'
const WORKER = 'worker'
const HELPER = 'helper'
const OTHER = 'other'
const NAMES: Record<string, string> = {
  [LEAD]: 'Lead',
  [WORKER]: 'Worker',
  [HELPER]: 'Helper',
  [OTHER]: 'Other',
}
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

/** A script is the run's events, a run that never ends, a run that goes on until it is
 *  aborted or {@link ScriptedAdapter.finishHeld} ends it, or a function of the run's start,
 *  for a run that does something on the board while it goes. */
type Script = RuntimeEvent[] | 'hang' | 'held' | (() => RuntimeEvent[])

class ScriptedAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'codex'
  readonly startOpts: StartOpts[] = []
  private readonly heldRuns: Array<(ending: RuntimeEvent) => void> = []
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
    const next = this.scripts.shift() ?? []
    const sk = run.sessionKey
    const heldRuns = this.heldRuns
    return (async function* () {
      if (next === 'hang') {
        await new Promise<never>(() => undefined)
        return
      }
      if (next === 'held') {
        const ending = await new Promise<RuntimeEvent>((res) => heldRuns.push(res))
        yield { ...ending, runId: sk, sessionId: sk, ts: 1, seq: 1 } as RuntimeEvent
        return
      }
      const script = typeof next === 'function' ? next() : next
      let seq = 0
      for (const ev of script) {
        seq += 1
        yield { ...ev, runId: sk, sessionId: sk, ts: seq, seq } as RuntimeEvent
      }
    })()
  }
  async abort(): Promise<void> {
    for (const end of this.heldRuns.splice(0))
      end({ kind: 'done', reason: 'aborted', summary: '' } as RuntimeEvent)
  }
  /** End the run that is being held, well. */
  finishHeld(summary: string): void {
    this.heldRuns.shift()?.({ kind: 'done', reason: 'success', summary } as RuntimeEvent)
  }
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

const done = (summary: string): RuntimeEvent =>
  ({ kind: 'done', reason: 'success', summary }) as RuntimeEvent
const failed = (summary: string): RuntimeEvent =>
  ({ kind: 'done', reason: 'error', summary }) as RuntimeEvent

type Adapters = Map<string, ScriptedAdapter>

function bootProcess(
  db: ClawbooDb,
  adapters: Adapters,
  opts: {
    stopGen?: () => number
    persisted?: Array<{ agentId: string; text: string }>
    board?: EngineBoardClient
    /** What the host wires for a pause: its read, the saved wakes, and a real abort. */
    pauses?: boolean
  } = {},
): { engine: BoardOrchestrator; deliver: ReturnType<typeof createServerDeliver> } {
  const engineRef: { current: BoardOrchestrator | null } = { current: null }
  const abortMap = new Map<string, RunEntry>()
  const stopGen = opts.stopGen ?? (() => 0)
  const deliver = createServerDeliver({
    db,
    teamId: TEAM,
    mcpBaseUrl: null,
    nudge: createNudgeQueue(),
    abortMap,
    onEvent: (sk, ev, run) => engineRef.current!.onEvent(sk, ev, run),
    onSessionClosed: (sk, run) => engineRef.current!.onSessionClosed(sk, run),
    onRunNotStarted: (run) => engineRef.current!.onRunNotStarted(run),
    takeHeldReportUps: (sk, taskId) => engineRef.current!.takeHeldReportUps(sk, taskId),
    taskForSession: (sk) => engineRef.current!.taskForSession(sk),
    execForSession: (sk) => engineRef.current!.execForSession(sk),
    stopGen,
    leaderAgentId: () => LEAD,
    persistTurn: (sk, text) => {
      opts.persisted?.push({ agentId: agentIdFromSessionKey(sk) ?? '', text })
    },
    makeAdapterForAgent: (agentId) => adapters.get(agentId) ?? null,
  })
  const engine = createBoardOrchestrator({
    teamId: TEAM,
    board: opts.board ?? createServerBoardClient(db),
    known: () => Object.entries(NAMES).map(([id, name]) => ({ id, name })),
    leaderAgentId: () => LEAD,
    sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
    agentIdForSession: (sk) => agentIdFromSessionKey(sk),
    deliver,
    stopGen,
    isSessionBusy: (sk) => abortMap.has(sk),
    isSessionOccupied: (sk) => abortMap.has(sk),
    reportUps: createReportUpOutbox(db, TEAM, null),
    ...(opts.pauses
      ? {
          taskWakes: createTaskWakeOutbox(db, TEAM, null),
          runHeldBy: ({ agentId, taskId }: { agentId: string; taskId: string | null }) => {
            const refusal = startRefusedBy(db, { agentId, teamId: TEAM, taskId })
            return refusal ? pauseTaskStopNote(refusal) : null
          },
          abortSession: (sk: string) => {
            const e = abortMap.get(sk)
            if (e) void e.adapter.abort(e.run).catch(() => undefined)
          },
        }
      : {}),
  })
  engineRef.current = engine
  return { engine, deliver }
}

const contextOf = (o: StartOpts): string => String(o.context ?? '')

describe('a task that hands out work waits for it, end to end', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-parent-waits-'))
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
        Object.entries(NAMES).map(([id, name]) => ({
          id,
          name,
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
    resetDb()
    vi.clearAllTimers()
    vi.useRealTimers()
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  const taskTitled = (title: string) =>
    listTasks(db, { teamId: TEAM }).find((t) => t.title === title)
  const unsettled = (): number => listPendingReportUps(db, TEAM, null).length

  /** The lead hands the worker a task whose run hands out two sub-tasks. */
  async function handOutTwo(
    adapters: Adapters,
    opts: Parameters<typeof bootProcess>[2] = {},
  ): Promise<{ engine: BoardOrchestrator }> {
    const p = bootProcess(db, adapters, opts)
    await p.deliver(skFor(LEAD), LEAD, 'build it', HUMAN_TURN)
    await settle(() => taskTitled('part a') !== undefined, 'the sub-tasks to exist')
    return { engine: p.engine }
  }
  const scriptFor = (over: Partial<Record<string, Script[]>> = {}): Adapters =>
    new Map(
      Object.keys(NAMES).map((id) => [
        id,
        new ScriptedAdapter(
          over[id] ??
            (id === LEAD
              ? [[done('<delegate to="@Worker">top task</delegate>')], [done('All done.')]]
              : id === WORKER
                ? [
                    [
                      done(
                        'I split it. <delegate to="@Helper">part a</delegate><delegate to="@Other">part b</delegate>',
                      ),
                    ],
                    [done('Both parts fit together.')],
                  ]
                : [[done(`${NAMES[id]} result`)]]),
        ),
      ]),
    )

  it('runs one follow-up with both results in its context, then the parent is done', async () => {
    const adapters = scriptFor()
    await handOutTwo(adapters)
    await settle(
      () => getTask(db, taskTitled('top task')!.id)?.status === 'done',
      'the parent done',
    )
    const top = taskTitled('top task')!
    const worker = adapters.get(WORKER)!
    expect(worker.startOpts).toHaveLength(2)
    const followUp = worker.startOpts[1]!
    expect(followUp.message).toContain('[Sub-tasks in]')
    expect(followUp.message).toContain('2 done')
    expect(contextOf(followUp)).toContain('Helper result')
    expect(contextOf(followUp)).toContain('Other result')
    // The run is a real run of the task: its own ledger row, with why it ran.
    const ledger = listExecutions(db, top.id)
    expect(ledger.map((e) => e.status)).toEqual(['succeeded', 'succeeded'])
    expect(ledger[1]!.runReason).toBe('subtasks_closed')
    expect(contextOf(followUp)).toContain('the work you handed out on it has closed')
    expect(getComments(db, top.id).map((c) => c.body)).toEqual(
      expect.arrayContaining(['Both parts fit together.']),
    )
    await settle(() => adapters.get(LEAD)!.startOpts.length >= 2, 'the lead to hear')
    await settle(() => unsettled() === 0, 'every report to settle')
    // The lead hears once, from the worker, when the task is done.
    const toLead = adapters.get(LEAD)!.startOpts.slice(1)
    expect(toLead).toHaveLength(1)
    expect(toLead[0]!.message).toContain('Both parts fit together.')
  })

  it('a restart between two sub-tasks neither starts it early nor loses the first', async () => {
    const adapters = scriptFor({ [OTHER]: ['hang'] })
    await handOutTwo(adapters)
    const top = taskTitled('top task')!
    const a = taskTitled('part a')!
    await settle(() => getTask(db, a.id)?.status === 'done', 'part a done')
    await settle(() => unsettled() === 1, 'its report to be written')
    expect(getTask(db, top.id)?.status).toBe('blocked')
    expect(adapters.get(WORKER)!.startOpts).toHaveLength(1)

    // The server dies. Part b's run dies with it, and the board puts part b back.
    const b = taskTitled('part b')!
    const lost = listExecutions(db, b.id).at(-1)!
    completeExecutionProcess(db, lost.id, { status: 'failed', error: 'process died' })
    updateStatus(db, b.id, 'todo')

    adapters.set(OTHER, new ScriptedAdapter([[done('Other result, second go')]]))
    const next = bootProcess(db, adapters)
    // Nothing has closed the wait, and the pass agrees.
    releaseFinishedSubtaskWaits(db)
    await next.engine.resume()
    await settle(() => getTask(db, b.id)?.status === 'done', 'part b done')
    await settle(() => getTask(db, top.id)?.status === 'done', 'the parent done')

    const worker = adapters.get(WORKER)!
    expect(worker.startOpts).toHaveLength(2)
    expect(contextOf(worker.startOpts[1]!)).toContain('Helper result')
    expect(contextOf(worker.startOpts[1]!)).toContain('Other result, second go')
  })

  it('a sub-task that fails reaches the follow-up, and the parent goes to a person', async () => {
    const adapters = scriptFor({ [OTHER]: [[failed('provider exploded')]] })
    await handOutTwo(adapters)
    const top = taskTitled('top task')!
    await settle(() => adapters.get(WORKER)!.startOpts.length === 2, 'the follow-up to start')
    const followUp = adapters.get(WORKER)!.startOpts[1]!
    expect(followUp.message).toContain('Did not finish')
    expect(followUp.message).toContain('part b')
    expect(contextOf(followUp)).toContain('provider exploded')
    expect(contextOf(followUp)).toContain('DID NOT COMPLETE')
    await settle(() => getTask(db, top.id)?.status === 'blocked', 'the parent to stop short')
    const row = getTask(db, top.id)!
    expect(row.waitingOn).toContain('"person"')
    expect(row.waitingOn).toContain('part b')
  })

  it('the lead’s own task waits too, and its summary reaches the chat', async () => {
    const persisted: Array<{ agentId: string; text: string }> = []
    const adapters = scriptFor({
      [LEAD]: [
        [done('On it. <delegate to="@Helper">part a</delegate>')],
        [done('Here is the whole plan.')],
      ],
    })
    const task = createTask(db, {
      title: 'Plan the launch',
      teamId: TEAM,
      status: 'todo',
      sourceDelegationId: encodeHumanAssignment(LEAD, 'n-1'),
    })
    const p = bootProcess(db, adapters, { persisted })
    expect(await p.engine.dispatchTask(task.id)).toBe('started')
    await settle(() => getTask(db, task.id)?.status === 'done', 'the lead’s task done')
    const lead = adapters.get(LEAD)!
    expect(lead.startOpts).toHaveLength(2)
    expect(contextOf(lead.startOpts[1]!)).toContain('Helper result')
    expect(persisted.map((e) => e.text)).toEqual(['Here is the whole plan.'])
  })

  it('a report_result of not_done, written by the Tasks tool, stops a Done', async () => {
    const adapters = scriptFor({
      [WORKER]: [
        () => {
          const t = taskTitled('top task')!
          expect(
            recordResultClaim(db, t.id, WORKER, { outcome: 'not_done', summary: 'No key.' }),
          ).toEqual({
            ok: true,
          })
          return [done('I got stuck.')]
        },
      ],
    })
    const p = bootProcess(db, adapters)
    await p.deliver(skFor(LEAD), LEAD, 'build it', HUMAN_TURN)
    await settle(
      () => getTask(db, taskTitled('top task')?.id ?? '')?.status === 'blocked',
      'the task to stop short',
    )
    const row = getTask(db, taskTitled('top task')!.id)!
    expect(row.waitingOn).toContain('No key.')
    // The claim is on the run, and the run closed as the success it was.
    const run = listExecutions(db, row.id).at(-1)!
    expect(run.status).toBe('succeeded')
    expect(run.resultClaim).toContain('not_done')
  })

  it('a failed move at parking is what the real stale sweep then recovers', async () => {
    const adapters = scriptFor({
      [WORKER]: [
        [done('I split it. <delegate to="@Helper">part a</delegate>')],
        [done('Parked, this time.')],
      ],
      [HELPER]: ['hang'],
    })
    const board = createServerBoardClient(db)
    let failing = true
    const update = board.updateStatus.bind(board)
    board.updateStatus = async (id, status, opts) =>
      failing && status === 'blocked' ? false : update(id, status, opts)
    const p = bootProcess(db, adapters, { board })
    await p.deliver(skFor(LEAD), LEAD, 'build it', HUMAN_TURN)
    await settle(() => taskTitled('part a') !== undefined, 'the sub-task to exist')
    const top = taskTitled('top task')!
    await settle(
      () => getComments(db, top.id).some((c) => c.body.includes('I split it.')),
      'the report to reach the card',
    )
    expect(getTask(db, top.id)?.status).toBe('in_progress')
    expect(listExecutions(db, top.id).at(-1)?.status).toBe('running')

    // The sweep looks for exactly that: an open run on a silent task.
    failing = false
    db.update(tasks).set({ updatedAt: 1 }).where(eq(tasks.id, top.id)).run()
    expect(reconcileStaleInProgress(db, 60_000).reconciled).toBe(1)
    expect(getTask(db, top.id)?.status).toBe('todo')
    await p.engine.resume()
    await settle(() => getTask(db, top.id)?.status === 'blocked', 'the rerun to park')
    expect(getTask(db, top.id)?.waitingOn).toContain('subtasks')
  })

  it('a room’s Stop leaves a parent the task runner runs alone', async () => {
    const parent = createTask(db, {
      title: 'A runner task',
      teamId: TEAM,
      status: 'todo',
      sourceDelegationId: 'r1:deleg:agent:worker:reflectTo:lead',
    })
    setTaskRunnerInputs(db, parent.id, {
      runtime: 'codex',
      assigneeAgentId: WORKER,
      repoPath: null,
      kind: null,
      model: null,
    })
    claimTask(db, parent.id, WORKER)
    createSubtask(db, parent.id, {
      title: 'its part',
      status: 'todo',
      sourceDelegationId: 'r2:deleg:agent:helper:reflectTo:worker',
    })
    updateStatus(db, parent.id, 'blocked', { waitingOn: { kind: 'subtasks' } })
    const client = createServerBoardClient(db)
    expect(await client.runsOnTaskRunner(parent.id)).toBe(true)

    const p = bootProcess(db, scriptFor())
    await p.engine.markStopped()
    expect(getTask(db, parent.id)?.status).toBe('blocked')
    expect(getTask(db, parent.id)?.waitingOn).toContain('subtasks')
    expect(listExecutions(db, parent.id)).toEqual([])
  })

  it('the lead’s follow-up is framed as the lead, and says its reply goes to the chat', async () => {
    const adapters = scriptFor({
      [LEAD]: [
        [done('On it. <delegate to="@Helper">part a</delegate>')],
        [done('Here is the whole plan.')],
      ],
    })
    const task = createTask(db, {
      title: 'Plan the launch',
      teamId: TEAM,
      status: 'todo',
      sourceDelegationId: encodeHumanAssignment(LEAD, 'n-2'),
    })
    const p = bootProcess(db, adapters)
    expect(await p.engine.dispatchTask(task.id)).toBe('started')
    await settle(() => adapters.get(LEAD)!.startOpts.length === 2, 'the lead’s follow-up')
    const followUp = adapters.get(LEAD)!.startOpts[1]!
    expect(followUp.message).toContain('goes to the team chat')
    expect(contextOf(followUp)).not.toContain('Your reply goes to your team lead')
    expect(contextOf(followUp)).not.toContain('posted on that task')
  })

  it('a worker’s follow-up says where a sub-task with no report keeps its result', async () => {
    const adapters = scriptFor()
    await handOutTwo(adapters)
    await settle(() => adapters.get(WORKER)!.startOpts.length === 2, 'the follow-up')
    const followUp = adapters.get(WORKER)!.startOpts[1]!
    expect(followUp.message).toContain('get_task')
    expect(followUp.message).not.toContain('team chat')
    expect(contextOf(followUp)).toContain('Your reply goes to your team lead')
  })

  describe('under a pause, which is not a Stop', () => {
    const NOTE = 'Paused by a person. This run was stopped and starts again on resume.'
    const pumpDeps = (engine: BoardOrchestrator): TaskWakePumpDeps => ({
      held: () => false,
      startForPerson: (task) => {
        void engine.dispatchTask(task.id)
      },
      startByItself: (task) => {
        void engine.dispatchTask(task.id, { automatic: true })
      },
      pumpRoom: () => {
        void engine.resume()
      },
      alert: () => true,
    })
    /** Everything that could start it, more than once, with time passing. */
    const pumpEverything = async (engine: BoardOrchestrator): Promise<void> => {
      for (let i = 0; i < 3; i++) {
        await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
        releaseFinishedSubtaskWaits(db)
        pumpTaskWakes(db, pumpDeps(engine))
        await engine.sweepStaleSessions()
        await engine.resume()
      }
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    }
    const replays = (): number[] => listPendingReportUps(db, TEAM, null).map((r) => r.replays)
    const allWakes = (): DbTaskWake[] => db.select().from(taskWakes).all() as DbTaskWake[]

    it('its follow-up waits, uncounted, and fires once on resume with every result', async () => {
      const adapters = scriptFor({
        [OTHER]: [
          () => {
            placePause(db, { kind: 'agent', id: WORKER })
            return [done('Other result')]
          },
        ],
      })
      const { engine } = await handOutTwo(adapters, { pauses: true })
      const top = taskTitled('top task')!
      await settle(() => getTask(db, top.id)?.status === 'todo', 'the wait to end')
      await settle(() => unsettled() === 2, 'both reports to be written')

      await pumpEverything(engine)
      const worker = adapters.get(WORKER)!
      expect(worker.startOpts).toHaveLength(1)
      expect(getTask(db, top.id)?.status).toBe('todo')
      expect(replays()).toEqual([0, 0])
      expect(listWaitingTaskWakes(db, { taskId: top.id })[0]).toMatchObject({
        reason: 'subtasks_closed',
        replays: 0,
        skipReason: 'paused',
      })
      // A person placed the pause: nothing about this needs them.
      expect(attentionForTask(db, top.id)).toBeNull()

      liftPause(db, 'agent', WORKER)
      pumpTaskWakes(db, pumpDeps(engine))
      await settle(() => getTask(db, top.id)?.status === 'done', 'the parent done')
      expect(worker.startOpts).toHaveLength(2)
      const followUp = worker.startOpts[1]!
      expect(followUp.message).toContain('[Sub-tasks in]')
      expect(followUp.message).toContain('2 done')
      expect(contextOf(followUp)).toContain('Helper result')
      expect(contextOf(followUp)).toContain('Other result')
      // A run of the engine's, with why it ran.
      const ledger = listExecutions(db, top.id)
      expect(ledger.map((e) => [e.status, e.runReason, e.engineRun])).toEqual([
        ['succeeded', 'delegation', 1],
        ['succeeded', 'subtasks_closed', 1],
      ])
      expect(allWakes().find((w) => w.taskId === top.id)).toMatchObject({
        settledHow: 'delivered',
        replays: 0,
      })
    })

    it('a sub-task it stopped holds the parent, and nobody is asked', async () => {
      const adapters = scriptFor({
        [HELPER]: ['held', [done('Helper result')]],
      })
      const { engine } = await handOutTwo(adapters, { pauses: true })
      const top = taskTitled('top task')!
      const a = taskTitled('part a')!
      await settle(() => taskTitled('part b')?.status === 'done', 'part b done')
      await settle(() => getTask(db, top.id)?.status === 'blocked', 'the parent to wait')

      placePause(db, { kind: 'agent', id: HELPER })
      expect(await engine.pauseRuns(({ agentId }) => agentId === HELPER, NOTE)).toEqual([a.id])
      await settle(() => getTask(db, a.id)?.status === 'todo', 'part a back in the queue')
      expect(listExecutions(db, a.id).at(-1)).toMatchObject({
        status: 'cancelled',
        errorClass: 'Paused',
      })

      await pumpEverything(engine)
      const row = getTask(db, top.id)!
      expect(row.status).toBe('blocked')
      expect(row.waitingOn).toContain('subtasks')
      // Not "1 needs you": it comes back by itself.
      expect(waitingOnDetailOf(db, row)).toEqual({ openSubtasks: 1 })
      expect(attentionForTask(db, top.id)).toBeNull()
      expect(adapters.get(WORKER)!.startOpts).toHaveLength(1)

      liftPause(db, 'agent', HELPER)
      await engine.resume()
      await settle(() => getTask(db, top.id)?.status === 'done', 'the parent done')
      const followUp = adapters.get(WORKER)!.startOpts[1]!
      expect(followUp.message).toContain('2 done')
      expect(followUp.message).not.toContain('Did not finish')
      expect(
        getComments(db, top.id)
          .map((c) => c.body)
          .join('\n'),
      ).not.toContain('closed over')
    })

    it('a follow-up it stops comes back on resume, with its results and its reason', async () => {
      const adapters = scriptFor({
        [WORKER]: [
          [
            done(
              'I split it. <delegate to="@Helper">part a</delegate><delegate to="@Other">part b</delegate>',
            ),
          ],
          'held',
          [done('Both parts fit together.')],
        ],
      })
      const { engine } = await handOutTwo(adapters, { pauses: true })
      const top = taskTitled('top task')!
      const worker = adapters.get(WORKER)!
      await settle(() => worker.startOpts.length === 2, 'the follow-up to start')
      expect(contextOf(worker.startOpts[1]!)).toContain('Helper result')

      placePause(db, { kind: 'agent', id: WORKER })
      expect(await engine.pauseRuns(({ agentId }) => agentId === WORKER, NOTE)).toEqual([top.id])
      await settle(() => getTask(db, top.id)?.status === 'todo', 'the task back in the queue')
      expect(listExecutions(db, top.id).at(-1)).toMatchObject({
        status: 'cancelled',
        errorClass: 'Paused',
        runReason: 'subtasks_closed',
      })

      await pumpEverything(engine)
      expect(worker.startOpts).toHaveLength(2)
      expect(replays()).toEqual([0, 0])
      expect(listWaitingTaskWakes(db, { taskId: top.id })[0]).toMatchObject({
        reason: 'subtasks_closed',
        replays: 0,
        carriedExecId: null,
        heldAt: null,
      })
      expect(attentionForTask(db, top.id)).toBeNull()

      liftPause(db, 'agent', WORKER)
      pumpTaskWakes(db, pumpDeps(engine))
      await settle(() => getTask(db, top.id)?.status === 'done', 'the parent done')
      expect(worker.startOpts).toHaveLength(3)
      expect(worker.startOpts[2]!.message).toContain('[Sub-tasks in]')
      expect(contextOf(worker.startOpts[2]!)).toContain('Helper result')
      expect(contextOf(worker.startOpts[2]!)).toContain('Other result')
      await settle(() => unsettled() === 0, 'every report to settle')
    })
  })

  describe('a teammate’s comment on a parent', () => {
    const cardOn = (taskId: string): unknown =>
      agentWakeCardsForTasks(db, [getTask(db, taskId)!]).get(taskId) ?? null
    const teammateSays = (taskId: string, body: string): ReturnType<typeof saveAgentCommentWake> =>
      saveAgentCommentWake(
        db,
        taskId,
        addComment(db, taskId, body, 'agent', OTHER, { kind: 'agent' }),
      )

    it('while it waits on its sub-tasks stays on the thread and wakes nothing', async () => {
      const adapters = scriptFor({ [OTHER]: ['hang'] })
      await handOutTwo(adapters)
      const top = taskTitled('top task')!
      await settle(() => getTask(db, top.id)?.status === 'blocked', 'the parent to wait')
      expect(teammateSays(top.id, 'Have you seen this?')).toEqual({ state: 'none' })
      expect(listWaitingTaskWakes(db, { taskId: top.id })).toEqual([])
      expect(cardOn(top.id)).toBeNull()
      expect(getComments(db, top.id).map((c) => c.body)).toContain('Have you seen this?')
    })

    it('from before it parked waits behind the wait, puts no card up, and rides the follow-up', async () => {
      const adapters = scriptFor({
        [WORKER]: [
          () => {
            const top = taskTitled('top task')!
            expect(teammateSays(top.id, 'Mind the edge case.')).toMatchObject({ state: 'saved' })
            return [
              done(
                'I split it. <delegate to="@Helper">part a</delegate><delegate to="@Other">part b</delegate>',
              ),
            ]
          },
          [done('Both parts fit together.')],
        ],
        [OTHER]: ['held'],
      })
      const { engine } = await handOutTwo(adapters, { pauses: true })
      const top = taskTitled('top task')!
      await settle(() => getTask(db, top.id)?.status === 'blocked', 'the parent to wait')
      await settle(() => taskTitled('part a')?.status === 'done', 'part a done')

      pumpTaskWakes(db, {
        held: () => false,
        startForPerson: () => undefined,
        startByItself: () => undefined,
        pumpRoom: () => undefined,
        alert: () => true,
      })
      expect(listWaitingTaskWakes(db, { taskId: top.id })[0]).toMatchObject({
        reason: 'agent_comment',
        skipReason: 'blocked',
      })
      expect(cardOn(top.id)).toBeNull()
      expect(getTask(db, top.id)?.status).toBe('blocked')

      adapters.get(OTHER)!.finishHeld('Other result')
      await settle(() => getTask(db, top.id)?.status === 'done', 'the parent done')
      await engine.sweepStaleSessions()
      const ledger = listExecutions(db, top.id)
      // One row per agent and task: the board's reason outranks a teammate's, and the
      // follow-up carries both.
      expect(ledger.at(-1)!.runReason).toBe('subtasks_closed')
      expect(adapters.get(WORKER)!.startOpts).toHaveLength(2)
      expect(contextOf(adapters.get(WORKER)!.startOpts[1]!)).toContain('Mind the edge case.')
    })
  })

  describe('what a person reads', () => {
    const readAll = (taskId: string): void => {
      const seq = taskReadStates(db, LOCAL_READER).get(taskId)?.activity?.seq
      if (seq !== undefined) markTaskRead(db, LOCAL_READER, taskId, seq)
    }
    const unread = (taskId: string): boolean | undefined =>
      taskReadStates(db, LOCAL_READER).get(taskId)?.unread

    it('a parent moving to wait, and moving back, is an agent’s progress: it is news', async () => {
      const adapters = scriptFor({ [OTHER]: ['held'] })
      await handOutTwo(adapters)
      const top = taskTitled('top task')!
      await settle(() => getTask(db, top.id)?.status === 'blocked', 'the parent to wait')
      expect(unread(top.id)).toBe(true)
      readAll(top.id)
      expect(unread(top.id)).toBe(false)
      adapters.get(OTHER)!.finishHeld('Other result')
      await settle(() => getTask(db, top.id)?.status === 'done', 'the parent done')
      expect(unread(top.id)).toBe(true)
    })

    it('a person’s Stop putting a waiting parent back in To do is their own: it is not', async () => {
      const adapters = scriptFor({ [OTHER]: ['held'] })
      let gen = 0
      const p = bootProcess(db, adapters, { stopGen: () => gen })
      await p.deliver(skFor(LEAD), LEAD, 'build it', HUMAN_TURN)
      await settle(() => taskTitled('part a') !== undefined, 'the sub-tasks to exist')
      const top = taskTitled('top task')!
      await settle(() => getTask(db, top.id)?.status === 'blocked', 'the parent to wait')
      readAll(top.id)

      await stopAsOwnWrite(db, LOCAL_READER, { teamId: TEAM, roomId: null }, async () => {
        gen += 1
        await p.engine.markStopped()
      })
      expect(getTask(db, top.id)?.status).toBe('todo')
      expect(unread(top.id)).toBe(false)
      // Its tombstone is the engine's own run too.
      expect(listExecutions(db, top.id).at(-1)).toMatchObject({ status: 'cancelled', engineRun: 1 })
    })
  })

  describe('who wrote what', () => {
    const logged = (kind: string, taskId: string): Array<Record<string, unknown>> =>
      listEvents(db, { limit: 1000 })
        .filter((e) => e.kind === kind && e.taskId === taskId)
        .map((e) => JSON.parse(e.data) as Record<string, unknown>)

    it('a parent’s report names its agent and run, and its move is clawboo’s own', async () => {
      const adapters = scriptFor({ [OTHER]: ['hang'] })
      await handOutTwo(adapters)
      const top = taskTitled('top task')!
      await settle(() => getTask(db, top.id)?.status === 'blocked', 'the parent to wait')
      const run = listExecutions(db, top.id).at(-1)!
      const report = getComments(db, top.id).find((c) => c.body.startsWith('I split it.'))!
      expect(report).toMatchObject({ kind: 'result', executionId: run.id })
      expect(
        logged('comment_added', top.id).find((d) => String(d['body']).startsWith('I split it.')),
      ).toMatchObject({ actor: { kind: 'agent', agentId: WORKER, execId: run.id } })
      const move = logged('status_changed', top.id).find((d) => d['to'] === 'blocked')!
      expect(move['actor']).toBeUndefined()
    })
  })

  it('the pump’s pass frees a parent no closing write could: a sub-task its ledger parked', async () => {
    const adapters = scriptFor({ [OTHER]: ['hang'] })
    await handOutTwo(adapters)
    const top = taskTitled('top task')!
    const a = taskTitled('part a')!
    await settle(() => getTask(db, a.id)?.status === 'done', 'part a done')
    const b = taskTitled('part b')!
    // A restart's reap, three times over: raw ledger rows, no engine terminal.
    completeExecutionProcess(db, listExecutions(db, b.id).at(-1)!.id, {
      status: 'failed',
      error: 'died',
    })
    updateStatus(db, b.id, 'todo')
    for (let i = 0; i < 2; i++) {
      const e = createExecutionProcess(db, { taskId: b.id, executorType: 'openclaw' })
      completeExecutionProcess(db, e.id, { status: 'failed', error: 'died' })
    }
    expect(getTask(db, top.id)?.status).toBe('blocked')
    expect(releaseFinishedSubtaskWaits(db)).toBe(1)
    expect(getTask(db, top.id)?.status).toBe('todo')
    expect(listTasks(db, { teamId: TEAM }).find((t) => t.id === top.id)?.waitingOn).toBeNull()
  })
})
