// Pausing an agent in team chat, end to end over the real engine, run primitive and
// board. It stops the agent's runs within seconds, nothing wakes it until it is
// resumed, its tasks stay its own, and resuming starts them again. Three of the cases
// are known failure shapes: a pause hanging in "pausing", a paused agent resumed through
// queued work, and an archived team that kept waking agents.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeHumanAssignment, PAUSED_RUN_CLASS } from '@clawboo/board-core'
import {
  createTask,
  getComments,
  getTask,
  liftPause,
  listExecutions,
  listPauses,
  listTasks,
  placePause,
  taskTreeRootId,
  teams,
  type ClawbooDb,
} from '@clawboo/db'
import { HUMAN_TURN, type BoardChange } from '@clawboo/team-orchestration'
import { eq, sql } from 'drizzle-orm'

import { getDb, resetDb } from '../../db'
import { homeDispatchMutex } from '../../executorRunner'
import { PausedDeliveryError } from '../../pauseBus'
import { runtimeIdentityHomePath } from '../../runtimes/identityHome'
import { createRunSlots, setRunSlotsForTests, type RunSlots } from '../../runSlots'
import {
  HeldAdapter,
  LEAD,
  openSandbox,
  OTHER,
  skFor,
  TEAM,
  TURN_NOTE,
  WORKER,
  wire,
} from './pauseHarness'
import { subscribeBoardChange } from '../boardChangeBus'
import { publishBoardChangeWithAttention } from '../publishBoardChange'
import { stopPausedRunsOf } from '../teamOrchestrator'
import { settle } from './settleCascade'

const NOTE = 'Stopped: this agent is paused. The task starts again on resume.'

describe('pausing an agent in team chat', () => {
  let db: ClawbooDb
  let close: () => Promise<void>
  let slots: RunSlots
  let adapters: Map<string, HeldAdapter>
  let lead: HeldAdapter
  let worker: HeldAdapter
  let other: HeldAdapter

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    ;({ db, close } = await openSandbox())
    slots = createRunSlots(4)
    setRunSlotsForTests(slots)
    lead = new HeldAdapter()
    worker = new HeldAdapter()
    other = new HeldAdapter()
    adapters = new Map([
      [LEAD, lead],
      [WORKER, worker],
      [OTHER, other],
    ])
  })
  afterEach(async () => {
    setRunSlotsForTests(null)
    await close()
    vi.useRealTimers()
  })

  /** A task a person gave `agent`, ready for the pump. */
  const assigned = (agent: string, title = 'work', priority = 0): string =>
    createTask(db, {
      title,
      teamId: TEAM,
      priority,
      sourceDelegationId: encodeHumanAssignment(agent, title),
    }).id

  const onlyWorker = ({ agentId }: { agentId: string }): boolean => agentId === WORKER

  it('stops its run within seconds, and its task goes back to To do, still its own', async () => {
    const h = wire(db, adapters)
    const id = assigned(WORKER)
    await h.engine.resume()
    await settle(() => worker.running, 'the worker to start')

    placePause(db, { kind: 'agent', id: WORKER })
    await h.pauseRuns(onlyWorker, NOTE)
    await settle(() => !worker.running, 'the run to end')

    expect(worker.aborts).toBeGreaterThan(0)
    const task = getTask(db, id)!
    expect(task.status).toBe('todo')
    expect(task.sourceDelegationId).toContain(`:agent:${WORKER}`)
    expect(listExecutions(db, id).at(-1)).toMatchObject({
      status: 'cancelled',
      errorClass: PAUSED_RUN_CLASS,
      error: NOTE,
    })
    expect(slots.stats().running).toBe(0)
  })

  it('wakes nothing until resumed, and then starts the task again', async () => {
    const h = wire(db, adapters)
    const id = assigned(WORKER)
    await h.engine.resume()
    await settle(() => worker.running, 'the worker to start')
    placePause(db, { kind: 'agent', id: WORKER })
    await h.pauseRuns(onlyWorker, NOTE)
    await settle(() => !worker.running, 'the run to end')

    // The pump comes round again, more than once.
    await h.engine.resume()
    await h.engine.resume()
    await settle(() => true, 'a pass')
    expect(worker.started).toBe(1)
    expect(await h.engine.dispatchTask(id)).toBe('not_ready')
    expect(getTask(db, id)!.status).toBe('todo')

    liftPause(db, 'agent', WORKER)
    await h.engine.resume()
    await settle(() => worker.started === 2, 'the run to start again')
    expect(getTask(db, id)!.status).toBe('in_progress')
  })

  it('leaves other agents alone', async () => {
    const h = wire(db, adapters)
    const mine = assigned(WORKER, 'mine')
    const theirs = assigned(OTHER, 'theirs')
    await h.engine.resume()
    await settle(() => worker.running && other.running, 'both to start')
    placePause(db, { kind: 'agent', id: WORKER })
    await h.pauseRuns(onlyWorker, NOTE)
    await settle(() => !worker.running, 'the run to end')
    expect(getTask(db, mine)!.status).toBe('todo')
    expect(getTask(db, theirs)!.status).toBe('in_progress')
    expect(other.running).toBe(true)
  })

  it('reads as paused straight away, even when the run never answers its abort', async () => {
    const h = wire(db, adapters)
    const id = assigned(WORKER)
    await h.engine.resume()
    await settle(() => worker.running, 'the worker to start')
    worker.abortHangs = true

    placePause(db, { kind: 'agent', id: WORKER })
    expect(listPauses(db)).toHaveLength(1)
    // The stop resolves though the run is still going: nothing waits on the runtime.
    await h.pauseRuns(onlyWorker, NOTE)
    expect(worker.running).toBe(true)
    expect(getTask(db, id)!.status).toBe('todo')

    // And it can be resumed with that run still stuck: no state to get out of first.
    expect(liftPause(db, 'agent', WORKER)).toBe(true)
    expect(listPauses(db)).toEqual([])
  })

  it('a queued run does not start when a slot frees, and queued work does not resume it', async () => {
    setRunSlotsForTests(createRunSlots(1))
    const h = wire(db, adapters)
    assigned(OTHER, 'holds the slot')
    await h.engine.resume()
    await settle(() => other.running, 'the other agent to start')
    // Claimed and waiting for the slot when the pause lands. No stop runs here: this
    // is the queue's own read of the pause.
    const id = assigned(WORKER, 'queued')
    await h.engine.resume()
    await settle(() => h.queuedRuns.has(skFor(WORKER)), 'the worker to queue')
    placePause(db, { kind: 'agent', id: WORKER })

    other.complete()
    await settle(() => !other.running, 'the slot to free')
    await settle(() => true, 'a pass')
    expect(worker.started).toBe(0)
    expect(listPauses(db)).toHaveLength(1)
    expect(getTask(db, id)!.status).toBe('in_progress')
  })

  it('starts a queued run on resume, in its place', async () => {
    const one = createRunSlots(1)
    setRunSlotsForTests(one)
    const h = wire(db, adapters)
    assigned(OTHER, 'holds the slot')
    await h.engine.resume()
    await settle(() => other.running, 'the other agent to start')
    assigned(WORKER, 'queued')
    await h.engine.resume()
    await settle(() => h.queuedRuns.has(skFor(WORKER)), 'the worker to queue')
    placePause(db, { kind: 'agent', id: WORKER })
    other.complete()
    await settle(() => !other.running, 'the slot to free')

    liftPause(db, 'agent', WORKER)
    one.resume()
    await settle(() => worker.started === 1, 'the queued run to start')
  })

  it('does not start a follow-up turn or a task update for it: they wait for the resume', async () => {
    const one = createRunSlots(4)
    setRunSlotsForTests(one)
    const h = wire(db, adapters)
    const id = assigned(OTHER, 'finished work')
    placePause(db, { kind: 'agent', id: WORKER })

    // Neither a follow-up on a task nor a task update is refused or lost, and its
    // delivery settles at once: the engine awaits it, and must not wait out a pause.
    await h.deliver(skFor(WORKER), WORKER, 'a follow-up', { kind: 'system', forTaskId: id })
    expect(h.queuedRuns.has(skFor(WORKER))).toBe(true)
    expect(worker.started).toBe(0)
    expect(one.stats()).toMatchObject({ running: 0, queued: 1 })

    liftPause(db, 'agent', WORKER)
    one.resume()
    await settle(() => worker.started === 1, 'the follow-up to start')
  })

  it("refuses a person's message with the reason in the chat, rather than leaving it waiting", async () => {
    const h = wire(db, adapters)
    placePause(db, { kind: 'agent', id: LEAD })
    await expect(h.deliver(skFor(LEAD), LEAD, 'hello', HUMAN_TURN)).rejects.toBeInstanceOf(
      PausedDeliveryError,
    )
    expect(lead.started).toBe(0)
    expect(h.meta.at(-1)).toContain('This agent is paused')
    expect(slots.stats()).toMatchObject({ running: 0, queued: 0 })
  })

  it("stops a lead's reply with the plain reason in the chat: no failure, and no task to come back", async () => {
    const h = wire(db, adapters)
    await h.deliver(skFor(LEAD), LEAD, 'hello', HUMAN_TURN)
    await settle(() => lead.running, 'the reply to start')
    placePause(db, { kind: 'agent', id: LEAD })
    await h.pauseRuns(({ agentId }) => agentId === LEAD, NOTE)
    await settle(() => !lead.running, 'the reply to stop')
    await settle(() => h.meta.length > 0, 'the reason to reach the chat')
    expect(h.meta).toEqual([TURN_NOTE])
  })

  it('stops a turn a pause landed on while it was starting: no stop path could see it yet', async () => {
    const h = wire(db, adapters)
    lead.onStart = () => {
      placePause(db, { kind: 'agent', id: LEAD })
    }
    await h.deliver(skFor(LEAD), LEAD, 'hello', HUMAN_TURN)
    await settle(() => lead.aborts > 0, 'the run to read the pause itself')
    await settle(() => !lead.running, 'the run to stop')
    expect(h.meta).toEqual([TURN_NOTE])
  })

  it('refuses a turn a pause landed on while it waited for its agent, before anything starts', async () => {
    const homeLead = new HeldAdapter({ persistentHome: true })
    adapters.set(LEAD, homeLead)
    const h = wire(db, adapters)
    let release!: () => void
    const held = homeDispatchMutex.run(
      runtimeIdentityHomePath('claude-code', LEAD),
      () =>
        new Promise<void>((r) => {
          release = r
        }),
    )
    const delivering = h.deliver(skFor(LEAD), LEAD, 'hello', HUMAN_TURN).catch((e: unknown) => e)
    await settle(() => slots.stats().running === 1, 'the turn to take its slot')
    placePause(db, { kind: 'agent', id: LEAD })
    release()
    await held
    expect(await delivering).toBeInstanceOf(PausedDeliveryError)
    expect(homeLead.started).toBe(0)
    expect(h.meta.at(-1)).toContain('This agent is paused')
  })

  it('a tree pause takes a queued follow-up out of the queue, so its free agent can work', async () => {
    const one = createRunSlots(1)
    setRunSlotsForTests(one)
    const h = wire(db, adapters)
    assigned(OTHER, 'holds the slot')
    await h.engine.resume()
    await settle(() => other.running, 'the other agent to start')

    const root = createTask(db, { title: 'tree', teamId: TEAM }).id
    void h.deliver(skFor(WORKER), WORKER, 'a follow-up', { kind: 'system', forTaskId: root })
    await settle(() => h.queuedRuns.has(skFor(WORKER)), 'the follow-up to queue')

    placePause(db, { kind: 'task_tree', id: root })
    await h.pauseRuns(({ taskId }) => taskId === root, NOTE)
    await settle(() => !h.queuedRuns.has(skFor(WORKER)), 'the follow-up to leave the queue')
    expect(worker.started).toBe(0)
    expect(one.stats().queued).toBe(0)
  })

  it('a hand-off to a paused agent waits: its sender hears no refusal, no failure counts, and it starts on resume', async () => {
    const h = wire(db, adapters)
    placePause(db, { kind: 'agent', id: WORKER })
    await h.engine.onEvent(skFor(LEAD), {
      kind: 'done',
      reason: 'success',
      summary: '<delegate to="@Worker">fix the login bug</delegate>',
      runId: 'r1',
      sessionId: null,
      ts: 1,
      seq: 1,
    })
    const [task] = listTasks(db, { teamId: TEAM })
    expect(task).toMatchObject({ status: 'todo' })
    await vi.advanceTimersByTimeAsync(60_000)
    expect(worker.started).toBe(0)
    // Nothing reached the sender: a `not_started` update would start a run of its own.
    expect(lead.started).toBe(0)
    expect(db.all(sql`SELECT * FROM delegation_failures`)).toEqual([])

    liftPause(db, 'agent', WORKER)
    await h.engine.resume()
    await settle(() => worker.running, 'the task to start on resume')
    expect(getTask(db, task!.id)?.status).toBe('in_progress')
  })

  it('marks a queued follow-up it takes out as stopped by a pause, so its next send is no try', async () => {
    const stamp = { reportForTaskId: 'x', stopGen: 0 }
    const cancel = vi.fn()
    await stopPausedRunsOf(
      {
        engine: { pauseRuns: async () => [], taskForSession: () => null },
        abortMap: new Map(),
        queuedRuns: new Map([[skFor(WORKER), { cancel, report: { taskId: 'x', stamp } }]]),
        teamId: TEAM,
      },
      () => true,
      { task: NOTE, turn: TURN_NOTE },
    )
    expect(cancel).toHaveBeenCalledOnce()
    expect(stamp).toMatchObject({ stoppedByPause: true })
  })

  it('a paused follow-up that runs on reads as a stop, and nobody hears it failed', async () => {
    const h = wire(db, adapters)
    const task = assigned(OTHER, 'finished work')
    void h.deliver(skFor(WORKER), WORKER, 'a follow-up', { kind: 'system', forTaskId: task })
    await settle(() => worker.running, 'the follow-up to start')

    placePause(db, { kind: 'agent', id: WORKER })
    await h.pauseRuns(({ agentId }) => agentId === WORKER, NOTE)
    await settle(() => !worker.running, 'the follow-up to stop')
    await settle(() => true, 'a pass')
    expect(
      getComments(db, task)
        .map((c) => c.body)
        .join(' '),
    ).not.toContain('did not finish')
  })

  it('survives a restart: the next engine fires nothing it covers', async () => {
    const first = wire(db, adapters)
    assigned(WORKER)
    placePause(db, { kind: 'agent', id: WORKER })
    await first.engine.resume()
    await settle(() => true, 'a pass')
    expect(worker.started).toBe(0)

    // The process is gone. A new connection to the same file, a new engine.
    resetDb()
    db = getDb()
    const second = wire(db, adapters)
    expect(listPauses(db).map((p) => p.id)).toEqual([WORKER])
    await second.engine.resume()
    await settle(() => true, 'a pass')
    expect(worker.started).toBe(0)
  })

  it('covers a whole task tree, and a sub-task made after the pause', async () => {
    const h = wire(db, adapters)
    const root = assigned(WORKER, 'root')
    const child = createTask(db, {
      title: 'child',
      teamId: TEAM,
      parentTaskId: root,
      sourceDelegationId: encodeHumanAssignment(OTHER, 'child'),
    }).id
    placePause(db, { kind: 'task_tree', id: taskTreeRootId(db, child) })
    const free = assigned(LEAD, 'outside the tree')
    await h.engine.resume()
    await settle(() => lead.running, 'the free task to start')
    expect(worker.started).toBe(0)
    expect(other.started).toBe(0)
    expect(getTask(db, free)!.status).toBe('in_progress')
  })

  it('a person pressing Stop outranks the pause: a stopped task does not fire on resume', async () => {
    const h = wire(db, adapters)
    assigned(WORKER)
    placePause(db, { kind: 'agent', id: WORKER })
    await h.stop()
    liftPause(db, 'agent', WORKER)
    await h.engine.resume()
    await settle(() => true, 'a pass')
    expect(worker.started).toBe(0)
  })

  it('wakes no agent of an archived team', async () => {
    const h = wire(db, adapters)
    const id = assigned(WORKER)
    db.update(teams).set({ isArchived: 1 }).where(eq(teams.id, TEAM)).run()
    await h.engine.resume()
    await settle(() => true, 'a pass')
    expect(worker.started).toBe(0)
    expect(getTask(db, id)!.status).toBe('todo')

    db.update(teams).set({ isArchived: 0 }).where(eq(teams.id, TEAM)).run()
    await h.engine.resume()
    await settle(() => worker.started === 1, 'the task to start once the team is back')
  })

  it('tells an open chat a task it just heard of is paused', async () => {
    placePause(db, { kind: 'agent', id: WORKER })
    const id = assigned(WORKER, 'made during the pause')
    const frames: BoardChange[] = []
    const off = subscribeBoardChange(TEAM, (c) => frames.push(c))
    publishBoardChangeWithAttention(db, TEAM, { id, status: 'todo' })
    off()
    expect(frames[0]?.pause).toMatchObject({ kind: 'agent', id: WORKER, name: WORKER })
  })

  it('starts an urgent claimed task ahead of an earlier queued run', async () => {
    setRunSlotsForTests(createRunSlots(1))
    const h = wire(db, adapters)
    assigned(LEAD, 'holds the slot')
    await h.engine.resume()
    await settle(() => lead.running, 'the lead to start')
    assigned(WORKER, 'normal, first')
    await h.engine.resume()
    await settle(() => h.queuedRuns.has(skFor(WORKER)), 'the normal run to queue')
    assigned(OTHER, 'urgent, later', 2)
    await h.engine.resume()
    await settle(() => h.queuedRuns.has(skFor(OTHER)), 'the urgent run to queue')

    lead.complete()
    await settle(() => other.started === 1, 'the urgent run to start')
    expect(worker.started).toBe(0)
  })
})
