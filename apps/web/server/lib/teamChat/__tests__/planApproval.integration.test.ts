// A team that asks before a plan starts, through the real engine, the real run primitive
// and the real board over sqlite, with scripted adapters. What must hold end to end: a
// lead's plan starts nothing and waits in Needs you; accepting it starts the first step
// once; turning it down starts nothing; either way nothing runs on the card, and the lead
// hears the decision, with the person's words, in the chat session that proposed the plan.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addComment,
  agents,
  answerQuestion,
  answerWords,
  attentionForTask,
  getTask,
  listExecutions,
  listTaskQuestions,
  listTasks,
  LOCAL_PERSON,
  orchestrationEvents,
  parseQuestionPayload,
  planApprovalSettingKey,
  setSetting,
  teams,
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
  type BoardOrchestrator,
} from '@clawboo/team-orchestration'

import { getDb, getDbPath, resetDb } from '../../db'
import { resetRunSteers } from '../../runSteers'
import { savePersonWake, startPersonWake } from '../personWake'
import { createReportUpOutbox } from '../reportUpOutbox'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'
import type { TaskWakePumpDeps } from '../taskWakes'
import { settle } from './settleCascade'

const TEAM = 'T'
const LEAD = 'lead'
const WORKER = 'worker'
const skFor = (id: string): string => buildTeamSessionKey(id, TEAM)!

const CAPS: Capabilities = {
  streaming: false,
  mcp: true,
  worktrees: true,
  resume: true,
  toolApproval: true,
  models: [],
  runtimeClass: 'wrapped-oneshot',
}

const ev = (sk: string, seq: number, e: Record<string, unknown>): RuntimeEvent =>
  ({ ...e, runId: sk, sessionId: sk, ts: seq, seq }) as RuntimeEvent

/** Plays back one reply per run. */
class Scripted implements RuntimeAdapter {
  readonly participantKind = 'agent' as const
  readonly starts: StartOpts[] = []
  constructor(
    readonly id: string,
    private readonly replies: string[],
  ) {}
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
    const reply = this.replies[this.starts.length - 1] ?? 'Done.'
    const sk = run.sessionKey
    return (async function* () {
      yield ev(sk, 1, { kind: 'done', reason: 'success', summary: reply })
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

const PLAN =
  'Here is what I propose. <plan><step to="@Writer">write the post</step><step to="@Writer">edit the post</step></plan>'

describe('a team that asks before a plan starts', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-plan-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    db = getDb()
    resetRunSteers()
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
      .values([
        { id: LEAD, name: 'Lead', gatewayId: LEAD, teamId: TEAM, createdAt: now, updatedAt: now },
        {
          id: WORKER,
          name: 'Writer',
          gatewayId: WORKER,
          teamId: TEAM,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run()
    setSetting(db, planApprovalSettingKey(TEAM), JSON.stringify({ on: true }))
  })

  afterEach(async () => {
    resetDb()
    resetRunSteers()
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  function makeEngine(
    lead: Scripted,
    worker: Scripted,
  ): {
    engine: BoardOrchestrator
    deliver: ReturnType<typeof createServerDeliver>
    pump: TaskWakePumpDeps
  } {
    const abortMap = new Map<string, RunEntry>()
    const ref: { current: BoardOrchestrator | null } = { current: null }
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      nudge: createNudgeQueue(),
      abortMap,
      onEvent: (sk, e, run) => ref.current!.onEvent(sk, e, run),
      onSessionClosed: (sk, run) => ref.current!.onSessionClosed(sk, run),
      taskForSession: (sk) => ref.current!.taskForSession(sk),
      execForSession: (sk) => ref.current!.execForSession(sk),
      stopGen: () => 0,
      leaderAgentId: () => LEAD,
      makeAdapterForAgent: (id) => (id === LEAD ? lead : id === WORKER ? worker : null),
    })
    const engine = createBoardOrchestrator({
      teamId: TEAM,
      board: createServerBoardClient(db),
      known: () => [
        { id: LEAD, name: 'Lead' },
        { id: WORKER, name: 'Writer' },
      ],
      leaderAgentId: () => LEAD,
      sessionKeyForAgent: (id) => buildTeamSessionKey(id, TEAM),
      agentIdForSession: (sk) => agentIdFromSessionKey(sk),
      deliver,
      stopGen: () => 0,
      caps: { maxFanout: 8 },
      reportUps: createReportUpOutbox(db, TEAM, null),
    })
    ref.current = engine
    return {
      engine,
      deliver,
      pump: {
        held: () => false,
        startForPerson: (t) => void engine.dispatchTask(t.id),
        pumpRoom: () => undefined,
        alert: () => false,
      },
    }
  }

  /** The person answers, as the route does. A card that only held the plan wakes no one:
   *  the update written with the answer tells the agent, in its own session. */
  function answerPlan(
    questionId: string,
    raw: Record<string, unknown>,
    pump: TaskWakePumpDeps,
  ): void {
    const answered = answerQuestion(db, questionId, raw, { person: LOCAL_PERSON })
    if (!answered.ok) throw new Error(`answer refused: ${answered.reason}`)
    const answer = JSON.parse(answered.question.answer ?? '{}') as QuestionAnswer
    const written = addComment(
      db,
      answered.task.id,
      answerWords(answer, { planCreated: true }),
      'user',
      null,
      { person: LOCAL_PERSON, kind: 'person' },
    )
    if (parseQuestionPayload(answered.question.payload)?.plan?.holder) return
    const saved = savePersonWake(db, answered.task, 'question_answered', {
      id: written.id,
      body: answerWords(answer, { planCreated: true }),
    })
    if (!saved.saved) throw new Error('no wake saved')
    startPersonWake(db, answered.task.id, saved.agentId, pump)
  }

  const STEP_REPLIES = ['Wrote it.', 'Edited it.']
  const isStep = (t: DbTask): boolean => (t.sourceDelegationId ?? '').includes(':plan:')

  it('a lead’s plan waits in Needs you; accepted, it runs in order, and only once', async () => {
    const lead = new Scripted('lead-rt', [PLAN, 'Thanks, they are running.'])
    const worker = new Scripted('worker-rt', STEP_REPLIES)
    const { engine, deliver, pump } = makeEngine(lead, worker)

    await deliver(skFor(LEAD), LEAD, 'write our launch post', HUMAN_TURN)
    await settle(() => listTasks(db, { teamId: TEAM }).length > 0, 'the plan reaching the board')

    // Nothing started. One card, waiting for a person, with an alert owed.
    expect(worker.starts).toHaveLength(0)
    const [card] = listTasks(db, { teamId: TEAM })
    expect(card?.status).toBe('blocked')
    expect(attentionForTask(db, card!.id)?.reason).toBe('question')
    const events = db.select().from(orchestrationEvents).all()
    expect(events.some((e) => e.kind === 'status_changed' && e.data?.includes('"plan":true'))).toBe(
      true,
    )
    const [question] = listTaskQuestions(db, card!.id)

    answerPlan(question!.id, { accepted: true, note: 'Go on' }, pump)
    await engine.resume()
    await settle(
      () =>
        listTasks(db, { teamId: TEAM }).filter((t) => isStep(t) && t.status === 'done').length >= 2,
      'the steps finishing',
    )

    // Each step ran once, in order.
    const asked = worker.starts.map((s) => s.message)
    expect(asked.filter((m) => /write the post/.test(m))).toHaveLength(1)
    expect(asked.filter((m) => /edit the post/.test(m))).toHaveLength(1)
    expect(worker.starts[0]!.message).toMatch(/write the post/)
    // The card closed with the answer, and nothing ever ran on it.
    expect(getTask(db, card!.id)?.status).toBe('done')
    expect(listExecutions(db, card!.id)).toEqual([])
    expect(
      answerQuestion(db, question!.id, { accepted: true }, { person: LOCAL_PERSON }),
    ).toMatchObject({ ok: false, reason: 'answered' })
    expect(listTasks(db, { teamId: TEAM })).toHaveLength(3)
  })

  it('accepted: the lead hears it in the chat session that proposed the plan', async () => {
    const lead = new Scripted('lead-rt', [PLAN, 'Thanks.'])
    const worker = new Scripted('worker-rt', STEP_REPLIES)
    const { engine, deliver, pump } = makeEngine(lead, worker)
    await deliver(skFor(LEAD), LEAD, 'write our launch post', HUMAN_TURN)
    await settle(() => listTasks(db, { teamId: TEAM }).length > 0, 'the plan reaching the board')
    const [card] = listTasks(db, { teamId: TEAM })
    answerPlan(listTaskQuestions(db, card!.id)[0]!.id, { accepted: true, note: 'Go on' }, pump)
    await engine.resume()
    await settle(() => lead.starts.length >= 2, 'the lead hearing the answer')
    const heard = lead.starts[1]!
    expect(heard.sessionKey).toBe(skFor(LEAD))
    expect(heard.message).toContain('[Task Update]')
    expect(heard.message).toContain('Do NOT hand them out again')
    expect(heard.message).toContain('Go on')
    expect(heard.message).not.toContain('DID NOT COMPLETE')
    expect(listExecutions(db, card!.id)).toEqual([])
  })

  it('turned down: nothing starts, and the lead hears why in that same session', async () => {
    const lead = new Scripted('lead-rt', [PLAN, 'Understood, I will do less.'])
    const worker = new Scripted('worker-rt', [])
    const { engine, deliver, pump } = makeEngine(lead, worker)

    await deliver(skFor(LEAD), LEAD, 'write our launch post', HUMAN_TURN)
    await settle(() => listTasks(db, { teamId: TEAM }).length > 0, 'the plan reaching the board')
    const [card] = listTasks(db, { teamId: TEAM })
    const [question] = listTaskQuestions(db, card!.id)

    answerPlan(question!.id, { accepted: false, note: 'Too much at once' }, pump)
    await engine.resume()
    await settle(() => lead.starts.length >= 2, 'the lead hearing the answer')

    expect(worker.starts).toHaveLength(0)
    expect(listTasks(db, { teamId: TEAM })).toHaveLength(1)
    expect(getTask(db, card!.id)?.status).toBe('cancelled')
    const heard = lead.starts[1]!
    expect(heard.sessionKey).toBe(skFor(LEAD))
    expect(heard.message).toContain('Do NOT propose the same steps again')
    expect(heard.message).toContain('Too much at once')
  })

  it('the same plan from the next chat turn makes no new card, and finished work does not run again', async () => {
    const lead = new Scripted('lead-rt', [PLAN, 'Noted.', PLAN, 'Noted.'])
    const worker = new Scripted('worker-rt', STEP_REPLIES)
    const { engine, deliver, pump } = makeEngine(lead, worker)
    await deliver(skFor(LEAD), LEAD, 'write our launch post', HUMAN_TURN)
    await settle(() => listTasks(db, { teamId: TEAM }).length > 0, 'the plan reaching the board')
    const [card] = listTasks(db, { teamId: TEAM })
    answerPlan(listTaskQuestions(db, card!.id)[0]!.id, { accepted: true }, pump)
    await engine.resume()
    await settle(
      () =>
        listTasks(db, { teamId: TEAM }).filter((t) => isStep(t) && t.status === 'done').length >= 2,
      'the steps finishing',
    )
    await settle(() => lead.starts.length >= 2, 'the lead hearing the answer')
    const tasksBefore = listTasks(db, { teamId: TEAM }).length

    await deliver(skFor(LEAD), LEAD, 'and how about that launch post?', HUMAN_TURN)
    await settle(() => lead.starts.length >= 3, 'the next chat turn')
    await settle(() => lead.starts.some((s) => /already accepted/.test(s.message)), 'the lead told')

    expect(listTasks(db, { teamId: TEAM })).toHaveLength(tasksBefore)
    expect(worker.starts).toHaveLength(2)
    const open = listTasks(db, { teamId: TEAM }).flatMap((t) =>
      listTaskQuestions(db, t.id).filter((q) => q.status === 'pending'),
    )
    expect(open).toEqual([])
  })

  it('switch off: the same plan starts at once', async () => {
    setSetting(db, planApprovalSettingKey(TEAM), JSON.stringify({ on: false }))
    const lead = new Scripted('lead-rt', [PLAN])
    const worker = new Scripted('worker-rt', ['Wrote it.', 'Edited it.'])
    const { deliver } = makeEngine(lead, worker)
    await deliver(skFor(LEAD), LEAD, 'write our launch post', HUMAN_TURN)
    await settle(() => worker.starts.length >= 2, 'both steps running')
    expect(listTaskQuestions(db, listTasks(db, { teamId: TEAM })[0]!.id)).toEqual([])
  })
})
