// A plan that waits for a person, where it meets the rest of the board: a pause, a task
// that waits for its sub-tasks, a routine's task, and a run that ends with nothing to say.
// Over the REAL engine, REAL run primitive, REAL board and REAL outbox on one temp SQLite
// file, with scripted adapters, wired the way teamOrchestrator wires them.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { isPlanHolder } from '@clawboo/board-core'
import {
  addComment,
  agents,
  answerQuestion,
  answerWords,
  attentionForTask,
  createTask,
  getComments,
  getDependencies,
  getTask,
  liftPause,
  listExecutions,
  listPendingReportUps,
  listTaskQuestions,
  listTasks,
  listWaitingTaskWakes,
  LOCAL_PERSON,
  parseQuestionPayload,
  placePause,
  planApprovalSettingKey,
  releaseFinishedSubtaskWaits,
  setSetting,
  startRefusedBy,
  teams,
  updateStatus,
  type ClawbooDb,
  type DbTask,
  type QuestionAnswer,
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
import { pauseTaskStopNote } from '../../pauseBus'
import type { ReplyDelivery } from '../personReply'
import { savePersonWake, startPersonWake } from '../personWake'
import { createReportUpOutbox } from '../reportUpOutbox'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'
import { createTaskWakeOutbox, pumpTaskWakes, type TaskWakePumpDeps } from '../taskWakes'
import { settle } from './settleCascade'

const TEAM = 'T'
const LEAD = 'lead'
const WORKER = 'worker'
const HELPER = 'helper'
const NAMES: Record<string, string> = { [LEAD]: 'Lead', [WORKER]: 'Worker', [HELPER]: 'Helper' }
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

/** Plays back one reply per run. Past the script, it says "Done." */
class Scripted implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly id = 'codex'
  readonly starts: StartOpts[] = []
  constructor(private readonly replies: string[] = []) {}
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
    const reply = this.replies.shift() ?? 'Done.'
    const sk = run.sessionKey
    return (async function* () {
      yield {
        kind: 'done',
        reason: 'success',
        summary: reply,
        runId: sk,
        sessionId: sk,
        ts: 1,
        seq: 1,
      } as RuntimeEvent
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

const LEAD_PLAN =
  '<plan><step to="@Worker">write the post</step><step to="@Worker">edit the post</step></plan>'
const WORKER_PLAN = '<plan><step to="@Helper">part a</step><step to="@Helper">part b</step></plan>'

describe('a plan that waits for a person, where it meets the rest of the board', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-plan-meetings-'))
    for (const k of ['HOME', 'CLAWBOO_HOME']) prev[k] = process.env[k]
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    resetDb()
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
    setSetting(db, planApprovalSettingKey(TEAM), JSON.stringify({ on: true }))
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

  type Adapters = Record<typeof LEAD | typeof WORKER | typeof HELPER, Scripted>

  function boot(adapters: Adapters): {
    engine: BoardOrchestrator
    deliver: ReturnType<typeof createServerDeliver>
    pump: TaskWakePumpDeps
  } {
    const ref: { current: BoardOrchestrator | null } = { current: null }
    const abortMap = new Map<string, RunEntry>()
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      nudge: createNudgeQueue(),
      abortMap,
      onEvent: (sk, ev, run) => ref.current!.onEvent(sk, ev, run),
      onSessionClosed: (sk, run) => ref.current!.onSessionClosed(sk, run),
      onRunNotStarted: (run) => ref.current!.onRunNotStarted(run),
      takeHeldReportUps: (sk, taskId) => ref.current!.takeHeldReportUps(sk, taskId),
      taskForSession: (sk) => ref.current!.taskForSession(sk),
      execForSession: (sk) => ref.current!.execForSession(sk),
      stopGen: () => 0,
      leaderAgentId: () => LEAD,
      makeAdapterForAgent: (id) => adapters[id as keyof Adapters] ?? null,
    })
    const engine = createBoardOrchestrator({
      teamId: TEAM,
      board: createServerBoardClient(db),
      known: () => Object.entries(NAMES).map(([id, name]) => ({ id, name })),
      leaderAgentId: () => LEAD,
      sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
      agentIdForSession: (sk) => agentIdFromSessionKey(sk),
      deliver,
      stopGen: () => 0,
      isSessionBusy: (sk) => abortMap.has(sk),
      isSessionOccupied: (sk) => abortMap.has(sk),
      reportUps: createReportUpOutbox(db, TEAM, null),
      taskWakes: createTaskWakeOutbox(db, TEAM, null),
      runHeldBy: ({ agentId, taskId }) => {
        const refusal = startRefusedBy(db, { agentId, teamId: TEAM, taskId })
        return refusal ? pauseTaskStopNote(refusal) : null
      },
    })
    ref.current = engine
    return {
      engine,
      deliver,
      pump: {
        held: () => false,
        startForPerson: (t) => void engine.dispatchTask(t.id),
        pumpRoom: () => void engine.resume(),
        alert: () => false,
      },
    }
  }

  /** The person answers, as the route does: the answer, its words on the thread and, on a
   *  task with work of its own, the wake. A card that only held the plan wakes no one. */
  function answerPlan(
    questionId: string,
    raw: Record<string, unknown>,
    pump: TaskWakePumpDeps,
  ): ReplyDelivery | null {
    const answered = answerQuestion(db, questionId, raw, { person: LOCAL_PERSON })
    if (!answered.ok) throw new Error(`answer refused: ${answered.reason}`)
    const answer = JSON.parse(answered.question.answer ?? '{}') as QuestionAnswer
    const words = answerWords(answer, { planCreated: true })
    const written = addComment(db, answered.task.id, words, 'user', null, {
      person: LOCAL_PERSON,
      kind: 'person',
    })
    if (parseQuestionPayload(answered.question.payload)?.plan?.holder) return null
    const saved = savePersonWake(db, answered.task, 'question_answered', {
      id: written.id,
      body: words,
    })
    if (!saved.saved) throw new Error('no wake saved')
    return startPersonWake(db, answered.task.id, saved.agentId, pump)
  }

  const tasksNow = (): DbTask[] => listTasks(db, { teamId: TEAM })
  const titled = (title: string): DbTask | undefined => tasksNow().find((t) => t.title === title)
  const stepsNow = (): DbTask[] =>
    tasksNow().filter((t) => (t.sourceDelegationId ?? '').includes(':plan:'))
  const pendingQuestion = (taskId: string) =>
    listTaskQuestions(db, taskId).find((q) => q.status === 'pending')
  const holderNow = (): DbTask | undefined =>
    tasksNow().find((t) => isPlanHolder(t.sourceDelegationId))

  /** Everything that could start something, more than once, with time passing. */
  async function pumpEverything(engine: BoardOrchestrator, pump: TaskWakePumpDeps): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
      releaseFinishedSubtaskWaits(db)
      pumpTaskWakes(db, pump)
      await engine.sweepStaleSessions()
      await engine.resume()
    }
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
  }

  const fresh = (over: Partial<Adapters> = {}): Adapters => ({
    [LEAD]: new Scripted(),
    [WORKER]: new Scripted(),
    [HELPER]: new Scripted(),
    ...over,
  })

  describe('under a pause', () => {
    it('a waiting plan stays as it is: no run, its question open, and it is answerable', async () => {
      const a = fresh({ [LEAD]: new Scripted([LEAD_PLAN]) })
      const { engine, deliver, pump } = boot(a)
      await deliver(skFor(LEAD), LEAD, 'write our launch post', HUMAN_TURN)
      await settle(() => holderNow() !== undefined, 'the plan on its card')
      const card = holderNow()!

      placePause(db, { kind: 'team', id: TEAM })
      await pumpEverything(engine, pump)

      expect(getTask(db, card.id)?.status).toBe('blocked')
      expect(pendingQuestion(card.id)).toBeDefined()
      expect(attentionForTask(db, card.id)?.reason).toBe('question')
      expect(listExecutions(db, card.id)).toEqual([])
      expect(a[LEAD].starts).toHaveLength(1)
    })

    it('an Accept creates its steps once; they wait, uncounted, and fire once on resume', async () => {
      const a = fresh({
        [LEAD]: new Scripted([LEAD_PLAN, 'Thanks.']),
        [WORKER]: new Scripted(['Wrote it.', 'Edited it.']),
      })
      const { engine, deliver, pump } = boot(a)
      await deliver(skFor(LEAD), LEAD, 'write our launch post', HUMAN_TURN)
      await settle(() => holderNow() !== undefined, 'the plan on its card')
      const card = holderNow()!
      const question = pendingQuestion(card.id)!

      placePause(db, { kind: 'team', id: TEAM })
      answerPlan(question.id, { accepted: true }, pump)
      await pumpEverything(engine, pump)

      // Made once, and nothing started: no run, so nothing is counted against them.
      expect(stepsNow()).toHaveLength(2)
      for (const step of stepsNow()) {
        expect(step.status).toBe('todo')
        expect(listExecutions(db, step.id)).toEqual([])
        expect(attentionForTask(db, step.id)).toBeNull()
      }
      expect(a[WORKER].starts).toEqual([])
      // Its card closed with the answer, with no run. The lead hears on resume, uncounted.
      expect(getTask(db, card.id)?.status).toBe('done')
      expect(listExecutions(db, card.id)).toEqual([])
      expect(a[LEAD].starts).toHaveLength(1)
      expect(listPendingReportUps(db, TEAM, null).map((r) => r.replays)).toEqual([0])
      // A second press changes nothing.
      expect(
        answerQuestion(db, question.id, { accepted: true }, { person: LOCAL_PERSON }),
      ).toMatchObject({ ok: false, reason: 'answered' })
      expect(stepsNow()).toHaveLength(2)

      liftPause(db, 'team', TEAM)
      await engine.resume()
      await settle(
        () => stepsNow().filter((s) => s.status === 'done').length === 2,
        'both steps done',
      )
      expect(
        a[WORKER].starts.map((s) => s.message).filter((m) => /write the post/.test(m)),
      ).toHaveLength(1)
      expect(
        a[WORKER].starts.map((s) => s.message).filter((m) => /edit the post/.test(m)),
      ).toHaveLength(1)
      await settle(() => a[LEAD].starts.length >= 2, 'the lead hearing the answer')
      expect(a[LEAD].starts[1]!.message).toContain('Do NOT hand them out again')
      expect(listExecutions(db, card.id)).toEqual([])
    })

    it('a card a person moved back starts nothing until the resume', async () => {
      const a = fresh({ [LEAD]: new Scripted([LEAD_PLAN, 'The plan was dropped.']) })
      const { engine, deliver, pump } = boot(a)
      await deliver(skFor(LEAD), LEAD, 'write our launch post', HUMAN_TURN)
      await settle(() => holderNow() !== undefined, 'the plan on its card')
      const card = holderNow()!

      placePause(db, { kind: 'team', id: TEAM })
      expect(updateStatus(db, card.id, 'todo', { actor: 'person' }).ok).toBe(true)
      await engine.dispatchTask(card.id)
      await pumpEverything(engine, pump)
      expect(a[LEAD].starts).toHaveLength(1)
      expect(getTask(db, card.id)?.status).toBe('todo')
      expect(listExecutions(db, card.id)).toEqual([])

      liftPause(db, 'team', TEAM)
      await engine.dispatchTask(card.id)
      await settle(() => getTask(db, card.id)?.status === 'done', 'the card done')
      expect(a[LEAD].starts).toHaveLength(2)
    })

    it('on the run’s own task: its wake says paused, starts nothing, and fires on resume', async () => {
      const a = fresh({
        [LEAD]: new Scripted(['<delegate to="@Worker">ship the launch</delegate>']),
        [WORKER]: new Scripted([WORKER_PLAN, 'Understood, waiting for the parts.', 'All in.']),
      })
      const { engine, deliver, pump } = boot(a)
      await deliver(skFor(LEAD), LEAD, 'ship it', HUMAN_TURN)
      await settle(
        () => pendingQuestion(titled('ship the launch')?.id ?? '') !== undefined,
        'asked',
      )
      const top = titled('ship the launch')!
      const question = pendingQuestion(top.id)!
      expect(a[WORKER].starts).toHaveLength(1)

      placePause(db, { kind: 'team', id: TEAM })
      const delivery = answerPlan(question.id, { accepted: true }, pump)
      expect(delivery).toMatchObject({ status: 'queued', reason: 'paused' })
      await pumpEverything(engine, pump)

      expect(a[WORKER].starts).toHaveLength(1)
      expect(a[HELPER].starts).toEqual([])
      expect(stepsNow()).toHaveLength(2)
      expect(listWaitingTaskWakes(db, { taskId: top.id })[0]).toMatchObject({
        reason: 'question_answered',
        replays: 0,
        skipReason: 'paused',
      })

      liftPause(db, 'team', TEAM)
      await pumpEverything(engine, pump)
      await settle(() => getTask(db, top.id)?.status === 'done', 'the task done')
      expect(a[HELPER].starts).toHaveLength(2)
    })
  })

  describe('a task that waits for its sub-tasks', () => {
    it('a plan on its own task: nothing reaches Done, then it waits for the steps it accepted', async () => {
      const a = fresh({
        [LEAD]: new Scripted(['<delegate to="@Worker">ship the launch</delegate>', 'Thanks.']),
        [WORKER]: new Scripted([WORKER_PLAN, 'Understood, waiting for the parts.', 'All in.']),
        [HELPER]: new Scripted(['Part a is in.', 'Part b is in.']),
      })
      const { engine, deliver, pump } = boot(a)
      await deliver(skFor(LEAD), LEAD, 'ship it', HUMAN_TURN)
      await settle(
        () => pendingQuestion(titled('ship the launch')?.id ?? '') !== undefined,
        'asked',
      )
      const top = titled('ship the launch')!

      // Its run closed as one that asked. The task did not reach Done with its plan open.
      await settle(
        () => listExecutions(db, top.id).at(-1)?.status === 'succeeded',
        'the asking run to close',
      )
      expect(getTask(db, top.id)?.status).toBe('blocked')
      expect(a[HELPER].starts).toEqual([])
      expect(holderNow()).toBeUndefined()

      answerPlan(pendingQuestion(top.id)!.id, { accepted: true }, pump)
      // Its steps hang under it, in a chain, and go to who the plan named.
      const first = titled('part a')
      const second = titled('part b')
      expect(first!.parentTaskId).toBe(top.id)
      expect(second!.parentTaskId).toBe(top.id)
      expect(getDependencies(db, second!.id).map((d) => d.id)).toEqual([first!.id])

      await pumpEverything(engine, pump)
      await settle(() => getTask(db, top.id)?.status === 'done', 'the task done')

      // The woken run, then one follow-up that heard both results, and only then Done.
      expect(a[WORKER].starts).toHaveLength(3)
      const followUp = a[WORKER].starts[2]!
      expect(followUp.message).toContain('[Sub-tasks in]')
      expect(String(followUp.context)).toContain('Part a is in.')
      expect(String(followUp.context)).toContain('Part b is in.')
      expect(a[HELPER].starts).toHaveLength(2)
      expect(listExecutions(db, top.id).map((e) => e.status)).toEqual([
        'succeeded',
        'succeeded',
        'succeeded',
      ])
      // The lead hears about the task once it is done, not about each of its parts.
      await settle(() => a[LEAD].starts.length >= 2, 'the lead to hear')
      expect(
        a[LEAD].starts
          .slice(1)
          .map((s) => s.message)
          .join('\n'),
      ).not.toContain('Part a is in.')
    })

    it('turned down on its own task: it runs once more, and with nothing out it finishes', async () => {
      const a = fresh({
        [LEAD]: new Scripted(['<delegate to="@Worker">ship the launch</delegate>', 'Thanks.']),
        [WORKER]: new Scripted([WORKER_PLAN, 'I did it all myself.']),
      })
      const { engine, deliver, pump } = boot(a)
      await deliver(skFor(LEAD), LEAD, 'ship it', HUMAN_TURN)
      await settle(
        () => pendingQuestion(titled('ship the launch')?.id ?? '') !== undefined,
        'asked',
      )
      const top = titled('ship the launch')!
      answerPlan(pendingQuestion(top.id)!.id, { accepted: false, note: 'Too much' }, pump)
      await pumpEverything(engine, pump)
      await settle(() => getTask(db, top.id)?.status === 'done', 'the task done')
      expect(stepsNow()).toEqual([])
      expect(a[HELPER].starts).toEqual([])
      expect(a[WORKER].starts).toHaveLength(2)
    })
  })

  describe('a routine’s task, which never waits for a person', () => {
    const routineTask = (): DbTask =>
      createTask(db, {
        title: 'nightly report',
        teamId: TEAM,
        status: 'todo',
        scheduledBy: 'clawboo',
        sourceDelegationId: `routine:deleg:agent:${WORKER}:reflectTo:${LEAD}`,
      })

    it('its plan goes to a card, and the run still finishes: the card is not work handed out', async () => {
      const a = fresh({ [WORKER]: new Scripted([WORKER_PLAN]) })
      const { engine, pump } = boot(a)
      const task = routineTask()
      await engine.dispatchTask(task.id)
      await settle(() => holderNow() !== undefined, 'the plan on its card')
      await settle(() => getTask(db, task.id)?.status === 'done', 'the routine’s task done')

      const card = holderNow()!
      expect(card.parentTaskId).toBe(task.id)
      expect(getTask(db, task.id)?.waitingOn ?? null).toBeNull()
      expect(attentionForTask(db, card.id)?.reason).toBe('question')

      // Accepted later, its steps still run, once each.
      answerPlan(pendingQuestion(card.id)!.id, { accepted: true }, pump)
      await pumpEverything(engine, pump)
      await settle(() => stepsNow().every((s) => s.status === 'done'), 'the steps done')
      expect(a[HELPER].starts).toHaveLength(2)
      expect(listExecutions(db, card.id)).toEqual([])
      expect(getTask(db, card.id)?.status).toBe('done')
    })
  })

  describe('a card a person moved back to To do', () => {
    it('with nothing to say, it gets no extra turn and is not a task with no result', async () => {
      const a = fresh({ [LEAD]: new Scripted([LEAD_PLAN, '']) })
      const { engine, deliver } = boot(a)
      await deliver(skFor(LEAD), LEAD, 'write our launch post', HUMAN_TURN)
      await settle(() => holderNow() !== undefined, 'the plan on its card')
      const card = holderNow()!

      expect(updateStatus(db, card.id, 'todo', { actor: 'person' }).ok).toBe(true)
      expect(pendingQuestion(card.id)).toBeUndefined()
      await engine.dispatchTask(card.id)
      await settle(() => getTask(db, card.id)?.status === 'done', 'the card done')
      await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS * 2)

      expect(a[LEAD].starts).toHaveLength(2)
      expect(a[LEAD].starts.some((s) => s.message.includes('[No reply]'))).toBe(false)
      expect(attentionForTask(db, card.id)).toBeNull()
      expect(listExecutions(db, card.id).map((e) => e.status)).toEqual(['succeeded'])
      expect(
        getComments(db, card.id).some((c) => c.kind === 'note' && /no reply/i.test(c.body)),
      ).toBe(false)
    })
  })
})
