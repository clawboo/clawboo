// A person's request from end to end: the real engine, the real run primitive, the real
// board and the real report-up outbox over a sandboxed database, with scripted agents.
// A restart here is what a restart does: the first engine stops hearing anything, its
// timers die, and a new engine reads the same database.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  agents,
  attentionForTask,
  claimTask,
  createExecutionProcess,
  createHandOffUnderRequest,
  getComments,
  getReadyTasks,
  getTask,
  listRoomsWithFireableDelegations,
  listRoomsWithIdleMainTasks,
  listTasks,
  mainTaskOfTask,
  mainTaskState,
  recordTaskWake,
  reconcileOrphans,
  reconcileStaleInProgress,
  teams,
  updateStatus,
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
  type BoardOrchestrator,
  type TurnOrigin,
} from '@clawboo/team-orchestration'

import { getDb, getDbPath, resetDb } from '../../db'
import { createReportUpOutbox } from '../reportUpOutbox'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'
import { pumpTaskWakes, type TaskWakePumpDeps } from '../taskWakes'
import { settle } from './settleCascade'

const TEAM = 'T'
const LEAD = 'lead'
const WORKER = 'worker'
const REVIEWER = 'reviewer'
const skFor = (id: string): string => buildTeamSessionKey(id, TEAM)!

const CAPS: Capabilities = {
  streaming: true,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
  runtimeClass: 'wrapped-oneshot',
}

class Scripted implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'codex'
  readonly starts: StartOpts[] = []
  constructor(private readonly scripts: RuntimeEvent[][]) {}
  capabilities(): Capabilities {
    return CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.starts.push(opts)
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const script = this.scripts.shift() ?? [done('(no script left)')]
    const sk = run.sessionKey
    return (async function* () {
      let seq = 0
      for (const ev of script) {
        // A run that is still going when the test ends.
        if (ev === STILL_WORKING) await new Promise(() => undefined)
        seq += 1
        yield { ...ev, runId: sk, sessionId: sk, ts: seq, seq } as RuntimeEvent
      }
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

const STILL_WORKING = { kind: 'status', phase: 'running' } as RuntimeEvent
const done = (summary: string): RuntimeEvent =>
  ({ kind: 'done', reason: 'success', summary }) as RuntimeEvent
const failed = (summary: string): RuntimeEvent =>
  ({ kind: 'done', reason: 'error', summary }) as RuntimeEvent
const handOff = (to: string, task: string): RuntimeEvent =>
  ({
    kind: 'tool-call',
    name: 'delegate',
    input: { assignee: to, task },
    partial: false,
  }) as RuntimeEvent

const person = { id: 'p1', name: 'Pat', role: null }
const asked = (words: string): TurnOrigin => ({
  kind: 'human',
  request: { words, requestedBy: person },
})

describe('a person’s request as one main task', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-main-task-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
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
        color: '#000',
        leaderAgentId: LEAD,
        createdAt: now,
        updatedAt: now,
      })
      .run()
    for (const [id, name] of [
      [LEAD, 'Lead'],
      [WORKER, 'Worker'],
      [REVIEWER, 'Reviewer'],
    ] as const)
      db.insert(agents)
        .values({
          id,
          name,
          gatewayId: id,
          sourceId: 'codex',
          runtime: 'codex',
          teamId: TEAM,
          createdAt: now,
          updatedAt: now,
        })
        .run()
  })

  afterEach(async () => {
    resetDb()
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  /** One server process's engine for the team. */
  function startEngine(adapters: Map<string, Scripted>) {
    const abortMap = new Map<string, RunEntry>()
    const nudge = createNudgeQueue()
    const persisted: Array<{ sk: string; text: string }> = []
    let alive = true
    const engineRef: { current: BoardOrchestrator | null } = { current: null }
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      nudge,
      abortMap,
      onEvent: (sk, ev, run) =>
        alive ? engineRef.current!.onEvent(sk, ev, run) : Promise.resolve(),
      onSessionClosed: (sk, run) =>
        alive ? engineRef.current!.onSessionClosed(sk, run) : Promise.resolve(),
      onRunNotStarted: (run) => engineRef.current!.onRunNotStarted(run),
      takeHeldReportUps: (sk) => engineRef.current!.takeHeldReportUps(sk),
      taskForSession: (sk) => engineRef.current!.taskForSession(sk),
      execForSession: (sk) => engineRef.current!.execForSession(sk),
      stopGen: () => 0,
      leaderAgentId: () => LEAD,
      persistTurn: (sk, text) => {
        persisted.push({ sk, text })
      },
      makeAdapterForAgent: (agentId) => adapters.get(agentId) ?? null,
    })
    const engine = createBoardOrchestrator({
      teamId: TEAM,
      board: createServerBoardClient(db),
      known: () => [
        { id: LEAD, name: 'Lead' },
        { id: WORKER, name: 'Worker' },
        { id: REVIEWER, name: 'Reviewer' },
      ],
      leaderAgentId: () => LEAD,
      sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
      agentIdForSession: (sk) => agentIdFromSessionKey(sk),
      deliver,
      stopGen: () => 0,
      isSessionBusy: (sk) => abortMap.has(sk),
      isSessionOccupied: (sk) => nudge.isBusy(sk) || abortMap.has(sk),
      reportUps: createReportUpOutbox(db, TEAM, null),
      caps: { maxFanout: 8 },
    })
    engineRef.current = engine
    return {
      engine,
      deliver,
      persisted,
      /** The process dies: nothing more reaches this engine. */
      kill: () => {
        alive = false
      },
    }
  }

  it('a plain answer stays in chat and makes nothing', async () => {
    const lead = new Scripted([[done('It is 4.')]])
    const { deliver, persisted } = startEngine(new Map([[LEAD, lead]]))
    await deliver(skFor(LEAD), LEAD, 'What is 2 + 2?', asked('What is 2 + 2?'))
    await settle(() => persisted.length >= 1, 'the answer')
    expect(listTasks(db, { teamId: TEAM })).toEqual([])
  })

  it('files the work under one main task, done after the summary, which goes to chat', async () => {
    const adapters = new Map([
      [
        LEAD,
        new Scripted([
          [handOff('Worker', 'write the form'), handOff('Reviewer', 'review it'), done('On it.')],
          [done('SUMMARY: the login page is in.')],
        ]),
      ],
      [WORKER, new Scripted([[done('form written')]])],
      [REVIEWER, new Scripted([[done('looks good')]])],
    ])
    const { deliver, persisted } = startEngine(adapters)
    await deliver(skFor(LEAD), LEAD, 'Build the login page', asked('Build the login page'))
    await settle(() => persisted.some((p) => p.text.includes('SUMMARY')), 'the lead’s summary')
    const rows = listTasks(db, { teamId: TEAM })
    const main = rows.find((t) => t.isMainTask === 1)!
    expect(main.title).toBe('Build the login page')
    expect(JSON.parse(main.requestedBy!)).toEqual(person)
    expect(main.assigneeAgentId).toBe(LEAD)
    expect(rows.filter((t) => t.isMainTask === 0).map((t) => t.parentTaskId)).toEqual([
      main.id,
      main.id,
    ])
    await settle(() => getTask(db, main.id)?.status === 'done', 'the request closing')
    expect(getComments(db, main.id).map((c) => c.body)).toContain('SUMMARY: the login page is in.')
    // It ran nothing itself.
    expect(
      db.$client
        .prepare('SELECT count(*) AS n FROM execution_processes WHERE task_id = ?')
        .get(main.id),
    ).toEqual({
      n: 0,
    })
    // Every update turn knew its request.
    const updates = adapters.get(LEAD)!.starts.slice(1)
    expect(updates.length).toBeGreaterThan(0)
    expect(updates.at(-1)!.message).toContain('closes the request')
  })

  it('survives a restart between two sub-tasks, and closes only after the summary', async () => {
    const first = new Map([
      [
        LEAD,
        new Scripted([[handOff('Worker', 'one'), handOff('Reviewer', 'two'), done('On it.')]]),
      ],
      [WORKER, new Scripted([[done('one done')]])],
      // The second agent's run never gets to finish before the process dies.
      [REVIEWER, new Scripted([[STILL_WORKING]])],
    ])
    const a = startEngine(first)
    await a.deliver(skFor(LEAD), LEAD, 'Do two things', asked('Do two things'))
    await settle(
      () => listTasks(db, { teamId: TEAM }).some((t) => t.status === 'done'),
      'the first sub-task',
    )
    const main = listTasks(db, { teamId: TEAM }).find((t) => t.isMainTask === 1)!
    expect(getTask(db, main.id)?.status).toBe('in_progress')
    a.kill()

    // The second one finishes while no engine listens; a new one comes up.
    const two = listTasks(db, { teamId: TEAM }).find(
      (t) => t.isMainTask === 0 && t.status !== 'done',
    )!
    updateStatus(db, two.id, 'done')
    expect(getTask(db, main.id)?.status).toBe('in_progress')

    const leadAfter = new Scripted([[done('SUMMARY: both are done.')]])
    const b = startEngine(new Map([[LEAD, leadAfter]]))
    await b.engine.resume()
    await b.engine.sweepStaleSessions()
    await settle(() => getTask(db, main.id)?.status === 'done', 'the request closing')
    expect(leadAfter.starts.length).toBeGreaterThan(0)
    expect(b.persisted.length).toBeGreaterThan(0)
    expect(getComments(db, main.id).map((c) => c.body)).toContain('SUMMARY: both are done.')
  })

  it('a sub-task that needs a person shows in Needs you, with its main task above it', async () => {
    const adapters = new Map([
      [
        LEAD,
        new Scripted([[handOff('Worker', 'write the form'), done('On it.')], [done('It failed.')]]),
      ],
      [WORKER, new Scripted([[failed('the disk is full')]])],
    ])
    const { deliver } = startEngine(adapters)
    await deliver(skFor(LEAD), LEAD, 'Build it', asked('Build it'))
    await settle(
      () => listTasks(db, { teamId: TEAM }).some((t) => t.status === 'blocked'),
      'the failure',
    )
    const sub = listTasks(db, { teamId: TEAM }).find((t) => t.isMainTask === 0)!
    const main = mainTaskOfTask(db, sub.id)!
    expect(attentionForTask(db, sub.id)?.reason).toBe('failed')
    expect(main.title).toBe('Build it')
    expect(attentionForTask(db, main.id)).toBeNull()
    expect(getTask(db, main.id)?.status).toBe('in_progress')
    expect(mainTaskState(db, main.id)?.openSubtasks).toBe(1)
  })

  it('a person’s comment reaches the lead, which can add work under the request', async () => {
    const adapters = new Map([
      [
        LEAD,
        new Scripted([
          [handOff('Worker', 'one'), done('On it.')],
          [handOff('Reviewer', 'logo'), done('Adding it.')],
        ]),
      ],
      [WORKER, new Scripted([[STILL_WORKING]])],
      [REVIEWER, new Scripted([[STILL_WORKING]])],
    ])
    const { deliver, engine } = startEngine(adapters)
    await deliver(skFor(LEAD), LEAD, 'Build it', asked('Build it'))
    await settle(() => listTasks(db, { teamId: TEAM }).length === 2, 'the hand-off')
    const main = listTasks(db, { teamId: TEAM }).find((t) => t.isMainTask === 1)!
    expect(await engine.personCommentedOnMainTask(main.id, 'Add a logo too')).toBe(true)
    await settle(() => listTasks(db, { teamId: TEAM }).length === 3, 'the added work')
    const leadStarts = adapters.get(LEAD)!.starts
    expect(leadStarts.at(-1)!.message).toContain('Add a logo too')
    const added = listTasks(db, { teamId: TEAM }).find((t) => t.title === 'logo')!
    expect(added.parentTaskId).toBe(main.id)
  })

  describe('with only the engine, and the run played by hand', () => {
    /** The engine over the real board and outbox, delivering to a list. */
    function engineByHand(known = [LEAD, WORKER, REVIEWER]) {
      let gen = 0
      const delivered: Array<{ sk: string; agentId: string; task: string; origin: TurnOrigin }> = []
      const roster = { ids: known }
      const engine = createBoardOrchestrator({
        teamId: TEAM,
        board: createServerBoardClient(db),
        known: () => roster.ids.map((id) => ({ id, name: id })),
        leaderAgentId: () => LEAD,
        sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
        agentIdForSession: (sk) => agentIdFromSessionKey(sk),
        deliver: async (sk, agentId, task, origin) => {
          delivered.push({ sk, agentId, task, origin })
        },
        stopGen: () => gen,
        reportUps: createReportUpOutbox(db, TEAM, null),
      })
      return { engine, delivered, roster, stop: () => (gen += 1), gen: () => gen }
    }
    const started = (engine: BoardOrchestrator, to: string, deliveryId: string) =>
      engine.onEvent(
        skFor(LEAD),
        {
          ...done(`<delegate to="@${to}">the work</delegate>`),
          runId: 'r',
          sessionId: null,
          ts: 1,
          seq: 1,
        } as RuntimeEvent,
        {
          reportForTaskId: null,
          stopGen: 0,
          deliveryId,
          request: { words: 'Build it', requestedBy: person },
        },
      )
    const ended = (summary: string): RuntimeEvent =>
      ({ ...done(summary), runId: 'r', sessionId: null, ts: 1, seq: 1 }) as RuntimeEvent

    it('after a Stop in its summary, the lead’s next run is all it takes', async () => {
      const h = engineByHand()
      await started(h.engine, WORKER, 'd1')
      await h.engine.onEvent(skFor(WORKER), ended('It is written.'))
      await vi.advanceTimersByTimeAsync(3_000)
      const update = h.delivered.at(-1)!
      expect(update.agentId).toBe(LEAD)
      const mainId = (update.origin as { mainTaskId: string }).mainTaskId
      const carried = (update.origin as { reportUpIds: string[] }).reportUpIds
      expect(carried.length).toBe(1)

      // The Stop lands during the summary, and the run ends cut short.
      h.stop()
      await h.engine.markStopped()
      await h.engine.onEvent(skFor(LEAD), { ...ended(''), reason: 'aborted' } as RuntimeEvent, {
        reportForTaskId: null,
        stopGen: 0,
        deliveryId: 'u1',
        mainTaskId: mainId,
        reportUpIds: carried,
      })
      const count = h.delivered.length
      await h.engine.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(h.delivered.length).toBe(count)
      expect(getTask(db, mainId)?.status).toBe('in_progress')

      // The person's next message: that run carries what the Stop held, and ends well.
      const held = h.engine.takeHeldReportUps(skFor(LEAD))
      expect(held?.ids.length).toBe(1)
      await h.engine.onEvent(skFor(LEAD), ended('Replying to something else.'), {
        reportForTaskId: null,
        stopGen: h.gen(),
        deliveryId: 'd2',
        reportUpIds: held!.ids,
        request: { words: 'Something else', requestedBy: person },
      })
      await h.engine.sweepStaleSessions()
      await vi.advanceTimersByTimeAsync(3_000)
      expect(getTask(db, mainId)?.status).toBe('done')
      expect(h.delivered.length).toBe(count)
      expect(
        getComments(db, mainId)
          .map((c) => c.body)
          .join('\n'),
      ).toMatch(/in the chat/)
    })

    it('a report for a lead who left goes to whoever looks after the request now', async () => {
      const h = engineByHand()
      await h.engine.onEvent(
        skFor(REVIEWER),
        {
          ...done(`<delegate to="@${WORKER}">the work</delegate>`),
          runId: 'r',
          sessionId: null,
          ts: 1,
          seq: 1,
        } as RuntimeEvent,
        {
          reportForTaskId: null,
          stopGen: 0,
          deliveryId: 'd1',
          request: { words: 'Build it', requestedBy: person },
        },
      )
      const main = listTasks(db, { teamId: TEAM }).find((t) => t.isMainTask === 1)!
      expect(main.assigneeAgentId).toBe(REVIEWER)
      // The agent move's own write, and the roster the engine reads.
      db.$client.prepare('UPDATE tasks SET assignee_agent_id = ? WHERE id = ?').run(LEAD, main.id)
      h.roster.ids = [LEAD, WORKER]
      await h.engine.onEvent(skFor(WORKER), ended('It is written.'))
      await vi.advanceTimersByTimeAsync(3_000)
      const update = h.delivered.at(-1)!
      expect(update.agentId).toBe(LEAD)
      expect(update.origin).toMatchObject({ kind: 'system', mainTaskId: main.id })
    })
  })

  it('no pump, sweep or reap touches a main task', async () => {
    const r = createHandOffUnderRequest(
      db,
      { title: 'Ask', description: 'Ask', leadAgentId: LEAD, key: 'main:T:d1' },
      { title: 'one', teamId: TEAM, sourceDelegationId: 'd1:deleg:agent:worker:reflectTo:lead' },
    )
    if (!r.ok) throw new Error(r.reason)
    const mainId = r.task.parentTaskId as string

    // Nothing lists it as work.
    expect(getReadyTasks(db, { teamId: TEAM }).map((t) => t.id)).toEqual([r.task.id])
    claimTask(db, r.task.id, WORKER)
    createExecutionProcess(db, { taskId: r.task.id, executorType: 'openclaw' })
    expect(listRoomsWithFireableDelegations(db)).toEqual([])

    // A wake someone saved on it is closed, and starts nothing.
    recordTaskWake(db, { teamId: TEAM, agentId: LEAD, taskId: mainId, reason: 'dependency_done' })
    const started: string[] = []
    const deps: TaskWakePumpDeps = {
      held: () => false,
      startForPerson: (t) => started.push(t.id),
      pumpRoom: () => started.push('room'),
      alert: () => true,
    }
    pumpTaskWakes(db, deps)
    expect(started).toEqual([])

    // The reaps go by a running execution, and it has none however old it is.
    db.$client.prepare('UPDATE tasks SET updated_at = 1 WHERE id = ?').run(mainId)
    reconcileStaleInProgress(db, 1)
    reconcileOrphans(db, { staleAfterMs: 1 })
    expect(getTask(db, mainId)?.status).toBe('in_progress')
    expect(getTask(db, mainId)?.assigneeAgentId).toBe(LEAD)
    expect(attentionForTask(db, mainId)).toBeNull()
  })

  it('the dispatch pump finds a request with nobody left to tell its lead', async () => {
    const r = createHandOffUnderRequest(
      db,
      { title: 'Ask', description: 'Ask', leadAgentId: LEAD, key: 'main:T:d1' },
      { title: 'one', teamId: TEAM, sourceDelegationId: 'd1:deleg:agent:worker:reflectTo:lead' },
    )
    if (!r.ok) throw new Error(r.reason)
    expect(listRoomsWithIdleMainTasks(db)).toEqual([])
    updateStatus(db, r.task.id, 'in_progress')
    updateStatus(db, r.task.id, 'done')
    expect(listRoomsWithIdleMainTasks(db)).toEqual([{ teamId: TEAM, roomId: null }])
    const lead = new Scripted([[done('SUMMARY: done.')]])
    const { engine, persisted } = startEngine(new Map([[LEAD, lead]]))
    await engine.resume()
    await settle(() => persisted.length >= 1, 'the lead asked')
    await settle(
      () => getTask(db, r.task.parentTaskId as string)?.status === 'done',
      'the request closing',
    )
    expect(lead.starts[0]!.message).toContain('closes the request')
  })

  it('a lead that cannot answer leaves the request with a person', async () => {
    const r = createHandOffUnderRequest(
      db,
      { title: 'Ask', description: 'Ask', leadAgentId: LEAD, key: 'main:T:d1' },
      { title: 'one', teamId: TEAM, sourceDelegationId: 'd1:deleg:agent:worker:reflectTo:lead' },
    )
    if (!r.ok) throw new Error(r.reason)
    const mainId = r.task.parentTaskId as string
    updateStatus(db, r.task.id, 'in_progress')
    updateStatus(db, r.task.id, 'cancelled')
    const outbox = createReportUpOutbox(db, TEAM, null)
    const row = outbox.record({ toAgentId: LEAD, by: 'x', summary: 'y', taskId: mainId })!
    outbox.settle([row], 'gave_up')
    const { engine } = startEngine(new Map([[LEAD, new Scripted([])]]))
    await engine.resume()
    expect(getTask(db, mainId)?.status).toBe('blocked')
    expect(attentionForTask(db, mainId)?.reason).toBe('blocked')
    expect(attentionForTask(db, mainId)?.detail).toMatch(/could not write the summary/)
  })
})
