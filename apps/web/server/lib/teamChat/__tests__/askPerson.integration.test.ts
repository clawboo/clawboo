// Ask, stop, answer, through the real engine, the real run primitive and the real
// board over sqlite, with scripted adapters. The worker's `ask_person` is the real
// Tasks tool, called while its run is live. What must hold end to end: the run ends
// waiting and closes as a success, the delegator hears the task waits on an answer,
// and the person's answer starts a new run with the answer in its ticket block.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  addComment,
  agents,
  answerQuestion,
  askQuestion,
  answerForAgent,
  answerWords,
  askedWords,
  getComments,
  getTask,
  handBackTask,
  listExecutions,
  listTaskQuestions,
  listTasks,
  LOCAL_PERSON,
  orchestrationEvents,
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
  type BoardOrchestrator,
} from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'

import { getDb, getDbPath, resetDb } from '../../db'
import { resetRunSteers } from '../../runSteers'
import { createServerBoardClient } from '../serverBoardClient'
import { createServerDeliver, type RunEntry } from '../serverDeliver'
import { deliverPersonReply } from '../personReply'
import { savePersonWake, startPersonWake } from '../personWake'
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

class LeadAdapter implements RuntimeAdapter {
  readonly id = 'lead-rt'
  readonly participantKind = 'agent' as const
  readonly messages: string[] = []
  capabilities(): Capabilities {
    return CAPS
  }
  async health(): Promise<{ ok: boolean }> {
    return { ok: true }
  }
  async start(_t: TaskHandle, opts: StartOpts): Promise<RunHandle> {
    this.messages.push(opts.message)
    return { adapterId: this.id, sessionKey: opts.sessionKey, runId: null }
  }
  events(run: RunHandle): AsyncIterable<RuntimeEvent> {
    const first = this.messages.length === 1
    const sk = run.sessionKey
    return (async function* () {
      yield ev(sk, 1, {
        kind: 'done',
        reason: 'success',
        summary: first ? '<delegate to="@Writer">write the launch post</delegate>' : 'Noted.',
      })
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

/** The worker: its first run asks a person; its next run finishes. */
class AskingWorker implements RuntimeAdapter {
  readonly id = 'worker-rt'
  readonly participantKind = 'agent' as const
  readonly starts: StartOpts[] = []
  constructor(
    private readonly db: () => ClawbooDb,
    private readonly first: 'ask' | 'hand_back' = 'ask',
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
    const first = this.starts.length === 1
    const sk = run.sessionKey
    const db = this.db
    const opening = this.first
    return (async function* () {
      if (first && opening === 'hand_back') {
        // What the agent's own `hand_back_task` call writes.
        const task = listTasks(db(), { teamId: TEAM })[0]!
        const back = handBackTask(db(), task.id, { agentId: WORKER, need: 'Press publish' })
        if (!back.ok) throw new Error(`hand back refused: ${back.reason}`)
      } else if (first) {
        // What the agent's own `ask_person` call writes.
        const task = listTasks(db(), { teamId: TEAM })[0]!
        const asked = askQuestion(db(), {
          taskId: task.id,
          agentId: WORKER,
          kind: 'question',
          payload: { prompt: 'Which audience?', options: ['Developers', 'Everyone'] },
        })
        if (!asked.ok) throw new Error(`ask refused: ${asked.reason}`)
      }
      yield ev(sk, 1, {
        kind: 'done',
        reason: 'success',
        summary: first ? 'I asked which audience to write for.' : 'The post, for developers.',
      })
    })()
  }
  async abort(): Promise<void> {}
  async setModel(): Promise<void> {}
  async writeContext(): Promise<void> {}
}

describe('ask, stop, answer', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-ask-person-'))
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

  it('the run ends waiting, the delegator is told, and the answer starts a run that has it', async () => {
    const lead = new LeadAdapter()
    const worker = new AskingWorker(() => db)
    const abortMap = new Map<string, RunEntry>()
    const engineRef: { current: BoardOrchestrator | null } = { current: null }
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      nudge: createNudgeQueue(),
      abortMap,
      onEvent: (sk, e, run) => engineRef.current!.onEvent(sk, e, run),
      onSessionClosed: (sk, run) => engineRef.current!.onSessionClosed(sk, run),
      taskForSession: (sk) => engineRef.current!.taskForSession(sk),
      execForSession: (sk) => engineRef.current!.execForSession(sk),
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
    })
    engineRef.current = engine

    await deliver(skFor(LEAD), LEAD, 'write our launch post', HUMAN_TURN)

    // The run ended, and the task waits: Blocked, on the question, run closed well.
    await settle(() => lead.messages.length >= 2, 'the lead hearing about the question')
    const task = listTasks(db, { teamId: TEAM })[0]!
    expect(task.status).toBe('blocked')
    const [question] = listTaskQuestions(db, task.id)
    expect(question?.status).toBe('pending')
    expect(listExecutions(db, task.id).map((e) => e.status)).toEqual(['succeeded'])
    expect(getComments(db, task.id).map((c) => c.body)).toContain(
      'I asked which audience to write for.',
    )

    // The delegator heard it waits on an answer, and was told not to redo it.
    const report = lead.messages[1]!
    expect(report).toContain('asked a person a question and waits for the answer')
    expect(report).toContain('Do NOT redo or reassign')
    expect(report).not.toContain('DID NOT COMPLETE')

    // The person answers, as the route does.
    const answered = answerQuestion(
      db,
      question!.id,
      { choice: 'Developers' },
      { person: LOCAL_PERSON },
    )
    if (!answered.ok) throw new Error(`answer refused: ${answered.reason}`)
    const answer = { kind: 'question', choice: 'Developers' } as const
    addComment(db, task.id, askedWords('Which audience?'), 'agent', question!.agentId)
    const written = addComment(db, task.id, answerWords(answer), 'user', null, {
      person: LOCAL_PERSON,
      kind: 'person',
    })
    const saved = savePersonWake(db, answered.task, 'question_answered', {
      id: written.id,
      body: answerForAgent('Which audience?', answer),
    })
    if (!saved.saved) throw new Error('no wake saved')
    const pump: TaskWakePumpDeps = {
      held: () => false,
      startForPerson: (t) => void engine.dispatchTask(t.id),
      startByItself: (t) => void engine.dispatchTask(t.id, { automatic: true }),
      pumpRoom: () => undefined,
      alert: () => false,
    }
    expect(startPersonWake(db, task.id, saved.agentId, pump).status).toBe('woke-agent')

    // A new run starts, with the answer in its ticket block, and finishes the task.
    await settle(() => getTask(db, task.id)?.status === 'done', 'the answered task finishing')
    expect(worker.starts).toHaveLength(2)
    const context = worker.starts[1]!.context ?? ''
    expect(context).toContain('[Your task on the board]')
    // The answer under the person's name, and the question under the agent's.
    expect(context).toMatch(/from=person[^\n]*\n\| Developers/)
    expect(context).toMatch(/from=Writer[^\n]*\n\| Asked a person: Which audience\?/)
    expect(listExecutions(db, task.id).map((e) => e.status)).toEqual(['succeeded', 'succeeded'])
    expect(getTask(db, task.id)?.waitingOn).toBeNull()
  })

  it('a hand-back ends the run the same way, and a person’s reply gives the turn back', async () => {
    const lead = new LeadAdapter()
    const worker = new AskingWorker(() => db, 'hand_back')
    const abortMap = new Map<string, RunEntry>()
    const engineRef: { current: BoardOrchestrator | null } = { current: null }
    const deliver = createServerDeliver({
      db,
      teamId: TEAM,
      mcpBaseUrl: null,
      nudge: createNudgeQueue(),
      abortMap,
      onEvent: (sk, e, run) => engineRef.current!.onEvent(sk, e, run),
      onSessionClosed: (sk, run) => engineRef.current!.onSessionClosed(sk, run),
      taskForSession: (sk) => engineRef.current!.taskForSession(sk),
      execForSession: (sk) => engineRef.current!.execForSession(sk),
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
    })
    engineRef.current = engine

    await deliver(skFor(LEAD), LEAD, 'write our launch post', HUMAN_TURN)
    await settle(() => lead.messages.length >= 2, 'the lead hearing about the hand-back')
    const task = listTasks(db, { teamId: TEAM })[0]!
    expect(task.status).toBe('blocked')
    expect(task.assigneePersonId).toBe('local')
    expect(task.assigneeAgentId).toBeNull()
    expect(listExecutions(db, task.id).map((e) => e.status)).toEqual(['succeeded'])
    // Its open-run count comes down: the agent is off the task, and the event still
    // names it, from the binding.
    const closed = db
      .select()
      .from(orchestrationEvents)
      .where(eq(orchestrationEvents.kind, 'execution_completed'))
      .all()
      .filter((e) => e.taskId === task.id)
    expect(closed.at(-1)?.agentId).toBe(WORKER)

    const reply = addComment(db, task.id, 'Pressed it. Carry on.', 'user', null, {
      kind: 'person',
    })
    const delivery = await deliverPersonReply(
      db,
      getTask(db, task.id)!,
      { id: reply.id, body: reply.body },
      { dispatch: (_teamId, id) => void engine.dispatchTask(id) },
    )
    expect(delivery.status).toBe('woke-agent')
    await settle(() => getTask(db, task.id)?.status === 'done', 'the task finishing')
    expect(worker.starts).toHaveLength(2)
    expect(getTask(db, task.id)?.assigneePersonId).toBeNull()
  })
})
