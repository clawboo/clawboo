// The process-wide run cap on team chat, with a cap of ONE slot. Wires the REAL
// engine (createBoardOrchestrator), the REAL run primitive (createServerDeliver) and
// the REAL board over sqlite as teamOrchestrator's buildInstance does, with scripted
// adapters that can hold a run open.
//
// The deadlock this guards against: the engine awaits `deliver` for a delegate
// while the lead's drain is inside `onEvent`, and the lead holds the only slot. A
// delegate that waited for the slot before `deliver` settled would wait on the lead,
// and the lead's drain on the delegate, forever. A delivery that finds every slot
// taken therefore settles at once and starts when the lead's run ends.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { encodeHumanAssignment } from '@clawboo/board-core'
import {
  agents,
  createTask,
  enqueueInbox,
  getComments,
  listExecutions,
  listTasks,
  listUndeliveredInbox,
  postToRoom,
  resolveRoomForTeam,
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
  OPEN_TOOL_CALL_TIMEOUT_MS,
  REFLECT_WINDOW_MS,
  type BoardOrchestrator,
} from '@clawboo/team-orchestration'

import { getDb, resetDb } from '../../db'
import { homeDispatchMutex } from '../../executorRunner'
import { createRunSlots, setRunSlotsForTests, type RunSlots } from '../../runSlots'
import { runtimeIdentityHomePath } from '../../runtimes/identityHome'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type QueuedRun, type RunEntry } from '../serverDeliver'
import { abortTaskRun } from '../teamOrchestrator'

import { settle } from './settleCascade'

const TEAM = 'T'
const LEAD = 'lead'
const WORKER = 'worker'
const OTHER = 'other'
const skFor = (id: string): string => buildTeamSessionKey(id, TEAM)!

// Ephemeral home: no per-agent lock, so only the run cap is in play.
const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: false,
  resume: false,
  toolApproval: false,
  models: [],
}
// A persistent home: the agent's runs serialize on its home lock, the run's slot key.
const HOME_CAPS: Capabilities = { ...CAPS, nativeHome: { scope: 'per-identity', persist: true } }

/** An event without its envelope, kept per variant. */
type Bare<T> = T extends unknown ? Omit<T, 'runId' | 'sessionId' | 'ts' | 'seq'> : never
/** One step of a scripted run: an event to emit, or a hold until the test releases it. */
type Step = Bare<RuntimeEvent> | 'hold'

/** Counts runs in flight across every adapter, from start to terminal. */
const live = { now: 0, max: 0 }

class ScriptedAdapter implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'claude-code'
  readonly starts: StartOpts[] = []
  /** Releases the run currently held at a 'hold' step. */
  release: (() => void) | null = null
  aborted = false
  failStart: Error | null = null
  constructor(
    private readonly name: string,
    private readonly scripts: Step[][],
    private readonly log: string[],
    private readonly caps: Capabilities = CAPS,
  ) {}
  capabilities(): Capabilities {
    return this.caps
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    if (this.failStart) throw this.failStart
    this.starts.push(opts)
    live.now += 1
    live.max = Math.max(live.max, live.now)
    this.log.push(`${this.name}:start`)
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const script = this.scripts.shift() ?? []
    const sk = run.sessionKey
    const hold = (): Promise<void> =>
      new Promise<void>((res) => {
        this.release = res
      })
    const unhold = (): void => {
      this.release = null
    }
    const aborted = (): boolean => this.aborted
    const ended = (): void => {
      live.now -= 1
      this.log.push(`${this.name}:end`)
    }
    return (async function* () {
      let seq = 0
      for (const step of script) {
        if (step === 'hold') {
          await hold()
          unhold()
          if (aborted()) {
            ended()
            yield {
              ...{ kind: 'done', reason: 'aborted', summary: '' },
              ...{ runId: sk, sessionId: sk, ts: 0, seq: ++seq },
            } as RuntimeEvent
            return
          }
          continue
        }
        if (step.kind === 'done') ended()
        seq += 1
        yield { ...step, runId: sk, sessionId: sk, ts: seq, seq } as RuntimeEvent
      }
    })()
  }
  async abort(): Promise<void> {
    this.aborted = true
    this.release?.()
  }
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

/** The host's queued-run map, remembering every session that ever queued. */
class RecordingQueue extends Map<string, QueuedRun> {
  readonly everQueued: string[] = []
  override set(key: string, value: QueuedRun): this {
    this.everQueued.push(key)
    return super.set(key, value)
  }
}

const done = (summary: string): Step => ({ kind: 'done', reason: 'success', summary })
const delegateTo = (assignee: string, task: string): Step =>
  ({
    kind: 'tool-call',
    toolCallId: 'tc1',
    name: 'delegate',
    input: { assignee, task },
    partial: false,
  }) as Step

describe('the run cap in team chat (cap of one slot)', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb
  let slots: RunSlots

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-team-run-cap-'))
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({
        id: TEAM,
        name: 'Cap Team',
        icon: 'x',
        color: '#000',
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
          sourceId: 'claude-code',
          runtime: 'claude-code',
          teamId: TEAM,
          createdAt: now,
          updatedAt: now,
        })),
      )
      .run()
    live.now = 0
    live.max = 0
    slots = createRunSlots(1)
    setRunSlotsForTests(slots)
  })
  afterEach(async () => {
    setRunSlotsForTests(null)
    resetDb()
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    await rm(home, { recursive: true, force: true })
  })

  /** The engine + deliver pair exactly as buildInstance wires them, plus its Stop. */
  function harness(adapters: Map<string, ScriptedAdapter>, opts?: { now?: () => number }) {
    const abortMap = new Map<string, RunEntry>()
    const queuedRuns = new RecordingQueue()
    const nudge = createNudgeQueue()
    const persisted: Array<{ sk: string; text: string }> = []
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
      taskForSession: (sk) => engineRef.current!.taskForSession(sk),
      execForSession: (sk) => engineRef.current!.execForSession(sk),
      stopGen: () => stopGen,
      leaderAgentId: () => LEAD,
      persistTurn: (sk, text) => {
        persisted.push({ sk, text })
      },
      persistMeta: (sk, text) => {
        persisted.push({ sk, text: `[meta] ${text}` })
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
      abortSession: (sk, taskId) => abortTaskRun({ abortMap, queuedRuns }, sk, taskId),
      caps: { maxFanout: 8 },
      ...(opts?.now ? { now: opts.now } : {}),
    })
    engineRef.current = engine
    /** teamOrchestrator's stop(), step for step. */
    const stop = (): void => {
      stopGen++
      for (const [, e] of abortMap) void e.adapter.abort(e.run).catch(() => undefined)
      for (const [, q] of queuedRuns) q.cancel()
      nudge.reset()
      void engine.markStopped()
    }
    return { deliver, engine, queuedRuns, persisted, stop }
  }

  it('a lead holding the only slot delegates; the delegate waits, then runs (no deadlock)', async () => {
    const order: string[] = []
    const lead = new ScriptedAdapter(
      'lead',
      [
        [delegateTo('Worker', 'write the parser'), 'hold', done('handed off')],
        [done('SYNTHESIS: parser done')],
      ],
      order,
    )
    const worker = new ScriptedAdapter('worker', [[done('parser written')]], order)
    const h = harness(
      new Map([
        [LEAD, lead],
        [WORKER, worker],
      ]),
    )

    await h.deliver(skFor(LEAD), LEAD, 'build a parser', HUMAN_TURN)
    // The lead streamed its delegation and is still working, holding the one slot.
    await settle(() => lead.release !== null, "the lead's hold")
    const task = listTasks(db, { teamId: TEAM })[0]!
    expect(task.status).toBe('in_progress')
    expect(worker.starts).toHaveLength(0)
    // The delegation was accepted and is waiting for a slot, not refused or failed.
    expect(h.queuedRuns.has(skFor(WORKER))).toBe(true)
    expect(slots.stats()).toEqual({ size: 1, running: 1, queued: 1 })

    // The lead's drain was never stuck behind its delegate: its run ends normally,
    // the slot passes to the delegate, and the cascade finishes.
    lead.release!()
    await settle(
      () => h.persisted.some((p) => p.text.includes('SYNTHESIS')),
      "the lead's synthesis",
    )

    expect(listTasks(db, { teamId: TEAM })[0]!.status).toBe('done')
    expect(worker.starts).toHaveLength(1)
    expect(lead.starts).toHaveLength(2)
    expect(order.slice(0, 4)).toEqual(['lead:start', 'lead:end', 'worker:start', 'worker:end'])
    // Never more than the cap at once.
    expect(live.max).toBe(1)
    expect(h.queuedRuns.size).toBe(0)
    expect(slots.stats()).toEqual({ size: 1, running: 0, queued: 0 })
  })

  it("a delegation the lead's terminal starts takes the slot the lead just gave back", async () => {
    const order: string[] = []
    const lead = new ScriptedAdapter(
      'lead',
      [[done('<delegate to="@Worker">write the parser</delegate>')], [done('SYNTHESIS')]],
      order,
    )
    const worker = new ScriptedAdapter('worker', [[done('parser written')]], order)
    const h = harness(
      new Map([
        [LEAD, lead],
        [WORKER, worker],
      ]),
    )

    await h.deliver(skFor(LEAD), LEAD, 'build a parser', HUMAN_TURN)
    await settle(
      () => h.persisted.some((p) => p.text.includes('SYNTHESIS')),
      "the lead's synthesis",
    )

    expect(worker.starts).toHaveLength(1)
    // It never had to queue: the lead's slot was free before the engine reacted.
    expect(h.queuedRuns.everQueued).not.toContain(skFor(WORKER))
    expect(live.max).toBe(1)
  })

  it('Stop takes a queued delegate out of the queue and releases its task cleanly', async () => {
    const order: string[] = []
    const lead = new ScriptedAdapter(
      'lead',
      [[delegateTo('Worker', 'write the parser'), 'hold', done('handed off')]],
      order,
    )
    const worker = new ScriptedAdapter('worker', [[done('parser written')]], order)
    const h = harness(
      new Map([
        [LEAD, lead],
        [WORKER, worker],
      ]),
    )

    await h.deliver(skFor(LEAD), LEAD, 'build a parser', HUMAN_TURN)
    await settle(() => lead.release !== null, "the lead's hold")
    expect(h.queuedRuns.has(skFor(WORKER))).toBe(true)
    const taskId = listTasks(db, { teamId: TEAM })[0]!.id

    h.stop()
    await settle(
      () => slots.stats().running === 0 && h.queuedRuns.size === 0,
      'every slot and the queue to empty',
    )

    // The queued delegate never started, and its task went back to To do as a stop,
    // not a failure: no Blocked, a cancelled execution, no failure notice.
    expect(worker.starts).toHaveLength(0)
    const task = listTasks(db, { teamId: TEAM }).find((t) => t.id === taskId)!
    expect(task.status).toBe('todo')
    expect(listExecutions(db, taskId).map((e) => e.status)).toEqual(['cancelled'])
    expect(
      getComments(db, taskId)
        .map((c) => c.body)
        .join('\n'),
    ).not.toMatch(/fail|did not complete/i)
    expect(h.persisted.filter((p) => p.text.startsWith('[meta]'))).toEqual([])
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)
    expect(lead.starts).toHaveLength(1) // no failure reflection woke the lead
    expect(slots.stats()).toEqual({ size: 1, running: 0, queued: 0 })
  })

  it("the engine's idle watchdog never fails a delegate waiting for a slot", async () => {
    let clock = Date.now()
    const order: string[] = []
    const lead = new ScriptedAdapter(
      'lead',
      [[delegateTo('Worker', 'write the parser'), 'hold', done('handed off')], [done('ok')]],
      order,
    )
    const worker = new ScriptedAdapter('worker', [[done('parser written')]], order)
    const h = harness(
      new Map([
        [LEAD, lead],
        [WORKER, worker],
      ]),
      { now: () => clock },
    )

    await h.deliver(skFor(LEAD), LEAD, 'build a parser', HUMAN_TURN)
    await settle(() => lead.release !== null, "the lead's hold")

    // An hour of waiting, past the 8-minute idle window and the 24-minute
    // pending-start one, swept the way the server's interval sweeps.
    for (let i = 0; i < 3; i++) {
      clock += OPEN_TOOL_CALL_TIMEOUT_MS
      await h.engine.sweepStaleSessions()
    }
    const task = listTasks(db, { teamId: TEAM })[0]!
    expect(task.status).toBe('in_progress')
    expect(listExecutions(db, task.id).map((e) => e.status)).toEqual(['running'])

    lead.release!()
    await settle(() => listTasks(db, { teamId: TEAM })[0]!.status === 'done', 'the task to be done')
    expect(worker.starts).toHaveLength(1)
  })

  it("a person's turn sent while every slot is taken waits for one, then settles as it starts", async () => {
    const order: string[] = []
    const other = new ScriptedAdapter('other', [['hold', done('other done')]], order)
    const lead = new ScriptedAdapter('lead', [[done('hello back')]], order)
    const h = harness(
      new Map([
        [OTHER, other],
        [LEAD, lead],
      ]),
    )

    await h.deliver(skFor(OTHER), OTHER, 'keep busy', HUMAN_TURN)
    await settle(() => other.release !== null, "the other agent's hold")
    // Nothing holding a slot awaits a person's message, so it waits for its slot
    // unsettled and its caller hears how the start went, as without the cap.
    let settled = false
    const delivery = h.deliver(skFor(LEAD), LEAD, 'hello', HUMAN_TURN).then(() => {
      settled = true
    })
    await settle(() => h.queuedRuns.has(skFor(LEAD)), "the lead's turn to queue")
    expect(settled).toBe(false)
    expect(lead.starts).toHaveLength(0)

    other.release!()
    await delivery
    expect(lead.starts).toHaveLength(1)
    await settle(() => h.persisted.some((p) => p.text.includes('hello back')), "the lead's reply")
    expect(order).toEqual(['other:start', 'other:end', 'lead:start', 'lead:end'])
  })

  describe("a person's message that never starts says so", () => {
    const NOT_STARTED = /stopped before it started/

    it('when a Stop takes it out of the queue for a slot', async () => {
      const order: string[] = []
      const other = new ScriptedAdapter('other', [['hold', done('other done')]], order)
      const lead = new ScriptedAdapter('lead', [[done('hello back')]], order)
      const h = harness(
        new Map([
          [OTHER, other],
          [LEAD, lead],
        ]),
      )
      await h.deliver(skFor(OTHER), OTHER, 'keep busy', HUMAN_TURN)
      await settle(() => other.release !== null, "the other agent's hold")
      const delivery = h.deliver(skFor(LEAD), LEAD, 'hello', HUMAN_TURN)
      await settle(() => h.queuedRuns.has(skFor(LEAD)), "the lead's turn to queue")

      h.stop()
      await delivery
      expect(lead.starts).toHaveLength(0)
      expect(h.persisted.filter((p) => p.sk === skFor(LEAD)).map((p) => p.text)).toEqual([
        expect.stringMatching(NOT_STARTED),
      ])
    })

    it('when a Stop drops it from behind the run on its session', async () => {
      const order: string[] = []
      const lead = new ScriptedAdapter('lead', [['hold', done('first')]], order)
      const h = harness(new Map([[LEAD, lead]]))
      await h.deliver(skFor(LEAD), LEAD, 'first', HUMAN_TURN)
      await settle(() => lead.release !== null, "the lead's hold")
      await h.deliver(skFor(LEAD), LEAD, 'second', HUMAN_TURN)

      h.stop()
      expect(h.persisted.filter((p) => NOT_STARTED.test(p.text))).toHaveLength(1)
    })

    it('but a task update dropped the same way waits for its next run, with no note', async () => {
      const order: string[] = []
      const lead = new ScriptedAdapter('lead', [['hold', done('first')]], order)
      const h = harness(new Map([[LEAD, lead]]))
      await h.deliver(skFor(LEAD), LEAD, 'first', HUMAN_TURN)
      await settle(() => lead.release !== null, "the lead's hold")
      await h.deliver(skFor(LEAD), LEAD, '[Task Update]', { kind: 'system' })

      h.stop()
      expect(h.persisted.filter((p) => NOT_STARTED.test(p.text))).toEqual([])
    })
  })

  it('a turn that waited for a slot starts with what reached its agent while it waited', async () => {
    const order: string[] = []
    const other = new ScriptedAdapter('other', [['hold', done('other done')]], order)
    const lead = new ScriptedAdapter('lead', [[done('noted')]], order)
    const h = harness(
      new Map([
        [OTHER, other],
        [LEAD, lead],
      ]),
    )

    await h.deliver(skFor(OTHER), OTHER, 'keep busy', HUMAN_TURN)
    await settle(() => other.release !== null, "the other agent's hold")
    const delivery = h.deliver(skFor(LEAD), LEAD, 'hello', HUMAN_TURN)
    await settle(() => h.queuedRuns.has(skFor(LEAD)), "the lead's turn to queue")
    // A teammate's result and a teammate's post reach the lead while its turn waits.
    enqueueInbox(db, {
      agentId: LEAD,
      teamId: TEAM,
      kind: 'task_update',
      body: 'Worker finished: the parser passes',
    })
    postToRoom(db, {
      roomId: resolveRoomForTeam(TEAM),
      teamId: TEAM,
      authorAgentId: WORKER,
      body: 'the parser lives in src/parse.ts',
      kind: 'peer',
    })

    other.release!()
    await delivery
    expect(lead.starts).toHaveLength(1)
    const context = lead.starts[0]!.context ?? ''
    expect(context).toContain('Worker finished: the parser passes')
    expect(context).toContain('the parser lives in src/parse.ts')
    // The row went out with this turn, so the next one does not carry it again.
    expect(listUndeliveredInbox(db, LEAD, { teamId: TEAM }).map((r) => r.body)).not.toContain(
      'Worker finished: the parser passes',
    )
  })

  it("a person's turn that waited and then fails to start rejects, so its caller can say so", async () => {
    const order: string[] = []
    const other = new ScriptedAdapter('other', [['hold', done('other done')]], order)
    const lead = new ScriptedAdapter('lead', [], order)
    lead.failStart = new Error('spawn claude ENOENT')
    const h = harness(
      new Map([
        [OTHER, other],
        [LEAD, lead],
      ]),
    )

    await h.deliver(skFor(OTHER), OTHER, 'keep busy', HUMAN_TURN)
    await settle(() => other.release !== null, "the other agent's hold")
    const delivery = h.deliver(skFor(LEAD), LEAD, 'hello', HUMAN_TURN)
    const outcome = delivery.then(
      () => 'resolved',
      (err: Error) => err.message,
    )
    await settle(() => h.queuedRuns.has(skFor(LEAD)), "the lead's turn to queue")

    other.release!()
    expect(await outcome).toBe('spawn claude ENOENT')
    expect(h.queuedRuns.size).toBe(0)
    await settle(() => slots.stats().running === 0, 'every slot to be free')
  })

  it('a delegate whose agent already holds a slot waits without one, so another agent goes first', async () => {
    const order: string[] = []
    setRunSlotsForTests((slots = createRunSlots(3)))
    const lead = new ScriptedAdapter(
      'lead',
      [
        [
          delegateTo('Worker', 'write the parser'),
          delegateTo('Other', 'write the docs'),
          'hold',
          done('handed off'),
        ],
        // The task updates that follow.
        [done('noted')],
        [done('noted')],
      ],
      order,
    )
    const worker = new ScriptedAdapter('worker', [[done('parser written')]], order, HOME_CAPS)
    const other = new ScriptedAdapter('other', [['hold', done('docs written')]], order, HOME_CAPS)
    const h = harness(
      new Map([
        [LEAD, lead],
        [WORKER, worker],
        [OTHER, other],
      ]),
    )
    // The worker is busy elsewhere (a board task, say): that run holds a slot keyed
    // on the worker's home lock, and the lock itself.
    const homeW = runtimeIdentityHomePath('claude-code', WORKER)
    const workerElsewhere = slots.tryAcquire(homeW)!
    let unlock!: () => void
    const lockHeld = homeDispatchMutex.run(homeW, () => new Promise<void>((r) => (unlock = r)))

    await h.deliver(skFor(LEAD), LEAD, 'split the work', HUMAN_TURN)
    await settle(
      () => lead.release !== null && other.release !== null,
      "the lead's and the other agent's holds",
    )
    // Every slot is in use, but by runs that are working: the worker's delegation
    // waits for its own agent without parking on the free slot the other agent took.
    expect(worker.starts).toHaveLength(0)
    expect(h.queuedRuns.has(skFor(WORKER))).toBe(true)
    expect(slots.stats()).toEqual({ size: 3, running: 3, queued: 1 })

    unlock()
    await lockHeld
    workerElsewhere.release()
    other.release!()
    lead.release!()
    await settle(
      () => listTasks(db, { teamId: TEAM }).every((t) => t.status === 'done'),
      'every task to be done',
    )
    expect(worker.starts).toHaveLength(1)
  })

  it("a Stop's ending for a delegate that waited on its agent's lock never fails a newer task", async () => {
    const order: string[] = []
    const lead = new ScriptedAdapter(
      'lead',
      [[delegateTo('Worker', 'first task'), 'hold', done('handed off')]],
      order,
    )
    const worker = new ScriptedAdapter('worker', [[done('second task done')]], order, HOME_CAPS)
    const h = harness(
      new Map([
        [LEAD, lead],
        [WORKER, worker],
      ]),
    )
    // Another run of the worker holds its home lock (not a slot) for a while.
    const homeW = runtimeIdentityHomePath('claude-code', WORKER)
    let unlock!: () => void
    const lockHeld = homeDispatchMutex.run(homeW, () => new Promise<void>((r) => (unlock = r)))

    await h.deliver(skFor(LEAD), LEAD, 'go', HUMAN_TURN)
    await settle(() => lead.release !== null, "the lead's hold")
    const t1 = listTasks(db, { teamId: TEAM })[0]!.id
    // The lead ends and its slot passes to the delegate, which now waits on the lock.
    lead.release!()
    await settle(
      () => lead.starts.length === 1 && slots.stats().running === 1 && order.includes('lead:end'),
      "the lead's end and its slot passing to the delegate",
    )

    // Stop. The engine releases the task; the board subscriber then detaches it.
    h.stop()
    await settle(
      () => listTasks(db, { teamId: TEAM }).find((t) => t.id === t1)?.status === 'todo',
      'the first task back in To do',
    )
    expect(h.engine.detachTask(t1)).toBe(true)

    // A newer task takes the worker's freed session and queues behind the old delivery.
    const t2 = createTask(db, {
      title: 'second task',
      status: 'todo',
      teamId: TEAM,
      sourceDelegationId: encodeHumanAssignment(WORKER, 'n2'),
    }).id
    expect(await h.engine.dispatchTask(t2)).toBe('started')

    // The old delivery gets the lock, sees the Stop and ends without a run. Its
    // ending must not reach the newer task.
    unlock()
    await lockHeld
    await settle(
      () => listTasks(db, { teamId: TEAM }).find((t) => t.id === t2)?.status === 'done',
      'the newer task to be done',
    )
    expect(listTasks(db, { teamId: TEAM }).find((t) => t.id === t2)?.status).toBe('done')
    expect(listTasks(db, { teamId: TEAM }).find((t) => t.id === t1)?.status).toBe('todo')
    expect(worker.starts).toHaveLength(1)
  })

  it('a queued delegate that fails to start fails its task with the reason', async () => {
    const order: string[] = []
    const lead = new ScriptedAdapter(
      'lead',
      [[delegateTo('Worker', 'write the parser'), 'hold', done('handed off')], [done('noted')]],
      order,
    )
    const worker = new ScriptedAdapter('worker', [], order)
    worker.failStart = new Error('spawn claude ENOENT')
    const h = harness(
      new Map([
        [LEAD, lead],
        [WORKER, worker],
      ]),
    )

    await h.deliver(skFor(LEAD), LEAD, 'build a parser', HUMAN_TURN)
    await settle(() => lead.release !== null, "the lead's hold")
    expect(h.queuedRuns.has(skFor(WORKER))).toBe(true)

    lead.release!()
    const taskId = listTasks(db, { teamId: TEAM })[0]!.id
    await settle(
      () => listTasks(db, { teamId: TEAM })[0]!.status === 'blocked',
      'the task to be blocked',
    )

    expect(listExecutions(db, taskId).map((e) => e.status)).toEqual(['failed'])
    expect(
      getComments(db, taskId)
        .map((c) => c.body)
        .join('\n'),
    ).toContain('spawn claude ENOENT')
    expect(h.queuedRuns.size).toBe(0)
    await settle(() => slots.stats().running === 0, 'every slot to be free')
    expect(slots.stats()).toEqual({ size: 1, running: 0, queued: 0 })
  })
})
