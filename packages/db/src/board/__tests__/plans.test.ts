// Plan documents, and plans that wait for a person on a team that asks first.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import {
  isEngineRun,
  LOCAL_PERSON,
  parseQuestionPayload,
  parseWaitingOn,
  TASK_DOCUMENT_MAX_CHARS,
  TASK_DOCUMENT_MAX_REVISIONS,
  type SuggestedTask,
} from '@clawboo/board-core'
import { DEFAULT_MAX_PLAN_STEPS } from '@clawboo/governance'
import { eq } from 'drizzle-orm'
import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, setSetting, type ClawbooDb } from '../../db'
import { listPendingReportUps } from '../../reportUps'
import { orchestrationEvents, taskComments, taskQuestions, tasks } from '../../schema'
import { attentionForTask } from '../attention'
import { SAME_TASK_WINDOW_MS } from '../createDedupe'
import {
  closeWaitingPlans,
  getTaskDocument,
  listTaskDocumentRevisions,
  planApprovalOn,
  planApprovalSettingKey,
  proposePlan,
  writeTaskDocument,
  type ProposePlanInput,
} from '../plans'
import { answerQuestion, listTaskQuestions } from '../questions'
import {
  claimTask,
  createTask,
  getDependencies,
  getReadyTasks,
  getTask,
  listExecutions,
  listTasks,
  releaseOneSubtaskWait,
  subtaskViewsOf,
  updateStatus,
} from '../repository'

let db: ClawbooDb
const person = { person: LOCAL_PERSON }
beforeEach(() => {
  db = createDb(':memory:')
})

const BOUND = 'run-1:deleg:agent:a2:reflectTo:leader'
const claimed = (extra: { scheduledBy?: string; parentTaskId?: string } = {}): string => {
  const t = createTask(db, {
    title: 'Ship it',
    teamId: 'T',
    status: 'todo',
    sourceDelegationId: BOUND,
    ...extra,
  })
  expect(claimTask(db, t.id, 'a2').ok).toBe(true)
  return t.id
}

const on = (d: ClawbooDb = db): void =>
  setSetting(d, planApprovalSettingKey('T'), JSON.stringify({ on: true }))

const STEPS: SuggestedTask[] = [
  { title: 'Run the tests', agentId: 'a3', agentName: 'Bug Boo' },
  { title: 'Fix what fails', agentId: 'a4', agentName: 'Design Boo' },
  { title: 'Run the tests again', agentId: 'a3', agentName: 'Bug Boo' },
]

const propose = (over: Partial<ProposePlanInput> = {}, d: ClawbooDb = db) =>
  proposePlan(d, {
    teamId: 'T',
    agentId: 'lead',
    prompt: 'Lead proposes 3 steps.',
    steps: STEPS,
    taskId: null,
    parentTaskId: null,
    turnId: 'turn-1',
    ...over,
  })

const accept = (id: string, extra: Record<string, unknown> = {}, d: ClawbooDb = db) =>
  answerQuestion(d, id, { accepted: true, ...extra }, person)

const stepsOf = (d: ClawbooDb = db) =>
  listTasks(d, { teamId: 'T' }).filter((t) => t.sourceDelegationId?.includes(':plan:'))

describe('plan documents', () => {
  it('keeps every revision, so one is readable after a newer one', () => {
    const id = claimed()
    const first = writeTaskDocument(db, { taskId: id, agentId: 'a2', body: 'First idea' })
    const second = writeTaskDocument(db, { taskId: id, agentId: 'a2', body: 'Better idea' })
    expect(first).toMatchObject({ ok: true, revision: 1 })
    expect(second).toMatchObject({ ok: true, revision: 2 })
    expect(getTaskDocument(db, id, 'plan')?.body).toBe('Better idea')
    expect(getTaskDocument(db, id, 'plan', 1)?.body).toBe('First idea')
    expect(listTaskDocumentRevisions(db, id, 'plan').map((r) => r.revision)).toEqual([2, 1])
  })

  it('a repeat of the newest body makes no new revision', () => {
    const id = claimed()
    writeTaskDocument(db, { taskId: id, agentId: 'a2', body: 'Same' })
    expect(writeTaskDocument(db, { taskId: id, agentId: 'a2', body: 'Same' })).toMatchObject({
      ok: true,
      revision: 1,
      unchanged: true,
    })
    expect(listTaskDocumentRevisions(db, id, 'plan')).toHaveLength(1)
  })

  it('refuses a body over the limit and an empty one, and keeps what was there', () => {
    const id = claimed()
    writeTaskDocument(db, { taskId: id, agentId: 'a2', body: 'Kept' })
    expect(
      writeTaskDocument(db, {
        taskId: id,
        agentId: 'a2',
        body: 'x'.repeat(TASK_DOCUMENT_MAX_CHARS + 1),
      }),
    ).toMatchObject({ ok: false, reason: 'too_long' })
    expect(writeTaskDocument(db, { taskId: id, agentId: 'a2', body: '   ' })).toMatchObject({
      ok: false,
      reason: 'empty',
    })
    expect(getTaskDocument(db, id, 'plan')?.body).toBe('Kept')
  })

  it('takes only the agent on the task, on a task still open', () => {
    const id = claimed()
    expect(writeTaskDocument(db, { taskId: id, agentId: 'other', body: 'Mine' })).toMatchObject({
      ok: false,
      reason: 'not_yours',
    })
    expect(writeTaskDocument(db, { taskId: 'nope', agentId: 'a2', body: 'Mine' })).toMatchObject({
      ok: false,
      reason: 'not_found',
    })
    expect(updateStatus(db, id, 'done').ok).toBe(true)
    expect(writeTaskDocument(db, { taskId: id, agentId: 'a2', body: 'Late' })).toMatchObject({
      ok: false,
      reason: 'finished',
    })
  })

  it('stops a writer stuck in a loop, without trimming what it wrote', () => {
    const id = claimed()
    for (let i = 0; i < TASK_DOCUMENT_MAX_REVISIONS; i += 1)
      expect(writeTaskDocument(db, { taskId: id, agentId: 'a2', body: `v${i}` }).ok).toBe(true)
    expect(writeTaskDocument(db, { taskId: id, agentId: 'a2', body: 'one more' })).toMatchObject({
      ok: false,
      reason: 'too_many_revisions',
    })
    expect(getTaskDocument(db, id, 'plan', 1)?.body).toBe('v0')
  })
})

describe('the switch', () => {
  it('is off until a person turns it on, for that team alone', () => {
    expect(planApprovalOn(db, 'T')).toBe(false)
    on()
    expect(planApprovalOn(db, 'T')).toBe(true)
    expect(planApprovalOn(db, 'other')).toBe(false)
    expect(planApprovalOn(db, null)).toBe(false)
  })

  it('off: proposing writes nothing at all', () => {
    expect(propose()).toEqual({ status: 'off' })
    expect(listTasks(db, { teamId: 'T' })).toEqual([])
  })

  it('reads a damaged setting as off, as the team work check does', () => {
    setSetting(db, planApprovalSettingKey('T'), 'not json')
    expect(planApprovalOn(db, 'T')).toBe(false)
  })
})

describe('proposing a plan', () => {
  beforeEach(() => on())

  it('on the run’s own task: blocks it, waiting on the question, in Needs you', () => {
    const id = claimed()
    const r = propose({ taskId: id, agentId: 'a2' })
    expect(r.status).toBe('proposed')
    if (r.status !== 'proposed') return
    expect(r.task.id).toBe(id)
    const task = getTask(db, id)!
    expect(task.status).toBe('blocked')
    expect(parseWaitingOn(task.waitingOn)).toEqual({ kind: 'question', questionId: r.question.id })
    expect(attentionForTask(db, id)?.reason).toBe('question')
    expect(r.question.kind).toBe('suggest_tasks')
    expect(stepsOf()).toEqual([])
  })

  it('with no task: a card of its own holds it, assigned to the agent and in Needs you', () => {
    const r = propose()
    expect(r.status).toBe('proposed')
    if (r.status !== 'proposed') return
    expect(r.holderCreated).toBe(true)
    expect(r.task.assigneeAgentId).toBe('lead')
    expect(r.task.status).toBe('blocked')
    expect(attentionForTask(db, r.task.id)?.reason).toBe('question')
    expect(listTasks(db, { teamId: 'T' })).toHaveLength(1)
    // Nothing reads as ready: the pump has no step to fire.
    expect(getReadyTasks(db, { teamId: 'T' })).toEqual([])
  })

  it('announces the wait in the event log, without the plan’s words', () => {
    const r = propose()
    expect(r.status).toBe('proposed')
    const rows = db.select().from(orchestrationEvents).all()
    const blocked = rows.find((e) => e.kind === 'status_changed')
    expect(blocked).toBeDefined()
    expect(blocked!.data).toContain('"reason":"question"')
    expect(blocked!.data).not.toContain('Run the tests')
  })

  it('writes the steps as a revision of the plan document', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(r.revision).toBe(1)
    expect(getTaskDocument(db, r.task.id, 'plan')?.body).toContain('1. Run the tests (Bug Boo)')
  })

  it('asks about the document the agent wrote, when it wrote one', () => {
    const id = claimed()
    writeTaskDocument(db, { taskId: id, agentId: 'a2', body: 'Why we do it this way' })
    const r = propose({ taskId: id, agentId: 'a2' })
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(r.revision).toBe(1)
    expect(getTaskDocument(db, id, 'plan')?.body).toBe('Why we do it this way')
    expect(listTaskDocumentRevisions(db, id, 'plan')).toHaveLength(1)
  })

  it('a re-issue of the same plan while one waits stacks nothing', () => {
    const first = propose()
    if (first.status !== 'proposed') throw new Error('not proposed')
    const again = propose({ turnId: 'turn-2' })
    expect(again).toMatchObject({ status: 'waiting', taskId: first.task.id })
    expect(listTaskQuestions(db, first.task.id)).toHaveLength(1)
    expect(listTasks(db, { teamId: 'T' })).toHaveLength(1)
    expect(listTaskDocumentRevisions(db, first.task.id, 'plan')).toHaveLength(1)
  })

  it('a different plan while one waits takes its place: still one question', () => {
    const first = propose()
    if (first.status !== 'proposed') throw new Error('not proposed')
    const next = propose({ turnId: 'turn-2', steps: STEPS.slice(0, 2) })
    expect(next.status).toBe('proposed')
    if (next.status !== 'proposed') return
    expect(next.task.id).toBe(first.task.id)
    expect(next.holderCreated).toBe(false)
    expect(next.revision).toBe(2)
    expect(listTasks(db, { teamId: 'T' })).toHaveLength(1)
    const rows = listTaskQuestions(db, first.task.id)
    expect(rows.map((q) => q.status).sort()).toEqual(['expired', 'pending'])
    const replaced = rows.find((q) => q.status === 'expired')!
    expect(replaced.id).toBe(first.question.id)
    expect(replaced.closeReason).toBe('replaced')
    // The older revision stays readable.
    expect(getTaskDocument(db, first.task.id, 'plan', 1)?.body).toContain('Run the tests again')
    // The old question is closed for good.
    expect(accept(replaced.id)).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('one agent’s waiting plan does not swallow another agent’s, or another room’s', () => {
    propose()
    expect(propose({ agentId: 'other', turnId: 'turn-2' }).status).toBe('proposed')
    expect(propose({ roomId: 'room-2', turnId: 'turn-3' }).status).toBe('proposed')
    expect(listTasks(db, { teamId: 'T' })).toHaveLength(3)
  })

  it('a replay of the turn that was already answered asks nothing new', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(accept(r.question.id).ok).toBe(true)
    expect(propose()).toMatchObject({ status: 'already_accepted', taskId: r.task.id, replay: true })
    expect(listTaskQuestions(db, r.task.id)).toHaveLength(1)
  })

  it('refuses more than the most steps whole, before anything exists', () => {
    const steps = Array.from({ length: DEFAULT_MAX_PLAN_STEPS + 1 }, (_, i) => ({
      title: `s${i}`,
      agentId: 'a3',
    }))
    expect(propose({ steps })).toMatchObject({ status: 'refused', reason: 'too_many_steps' })
    expect(listTasks(db, { teamId: 'T' })).toEqual([])
  })

  it('refuses a step too long to read, whole', () => {
    const steps = [{ title: 'Long', description: 'x'.repeat(4_001), agentId: 'a3' }]
    expect(propose({ steps })).toMatchObject({ status: 'refused', reason: 'step_too_long' })
    expect(listTasks(db, { teamId: 'T' })).toEqual([])
  })

  it('a routine’s task never waits: the plan gets a card of its own, once', () => {
    const id = claimed({ scheduledBy: 'clawboo' })
    const r = propose({ taskId: id, agentId: 'a2' })
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(r.task.id).not.toBe(id)
    expect(getTask(db, id)?.status).toBe('in_progress')
    // The next fire's task, with the same plan, stacks nothing.
    const next = claimed({ scheduledBy: 'clawboo' })
    expect(propose({ taskId: next, agentId: 'a2', turnId: 'turn-2' })).toMatchObject({
      status: 'waiting',
      taskId: r.task.id,
    })
  })

  it('without a card of its own, a task it cannot wait on says so', () => {
    const id = claimed({ scheduledBy: 'clawboo' })
    expect(propose({ taskId: id, agentId: 'a2', holderAllowed: false })).toMatchObject({
      status: 'refused',
      reason: 'routine',
    })
  })

  it('a task already at the deepest level refuses a plan before anyone is asked', () => {
    const top = createTask(db, { title: 'top', teamId: 'T' })
    const mid = createTask(db, { title: 'mid', teamId: 'T', parentTaskId: top.id })
    const leaf = claimed({ parentTaskId: mid.id })
    expect(propose({ taskId: leaf, agentId: 'a2' })).toMatchObject({
      status: 'refused',
      reason: 'too_deep',
    })
    expect(getTask(db, leaf)?.status).toBe('in_progress')
  })
})

describe('accepting a plan', () => {
  beforeEach(() => on())

  it('creates the steps and their chain, in one write', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = accept(r.question.id)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.created?.map((t) => t.title)).toEqual(STEPS.map((s) => s.title))
    const [one, two, three] = a.created!
    expect(getDependencies(db, one!.id)).toEqual([])
    expect(getDependencies(db, two!.id).map((d) => d.id)).toEqual([one!.id])
    expect(getDependencies(db, three!.id).map((d) => d.id)).toEqual([two!.id])
    // Only the first is ready, and it knows who it goes to and who hears the result.
    expect(getReadyTasks(db, { teamId: 'T' }).map((t) => t.id)).toEqual([one!.id])
    expect(one!.sourceDelegationId).toContain(':agent:a3:reflectTo:lead')
    expect(two!.sourceDelegationId).toContain(':agent:a4:reflectTo:lead')
    expect(getTaskDocument(db, r.task.id, 'plan', r.revision)?.decision).toBe('accepted')
    expect(getTaskDocument(db, r.task.id, 'plan', r.revision)?.decidedBy).toContain('"id":"local"')
  })

  it('accepting twice creates nothing the second time', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(accept(r.question.id).ok).toBe(true)
    const before = listTasks(db, { teamId: 'T' }).length
    expect(accept(r.question.id)).toMatchObject({ ok: false, reason: 'answered' })
    expect(listTasks(db, { teamId: 'T' })).toHaveLength(before)
  })

  it('accepting across a restart creates nothing more, and the steps survive', () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-plan-'))
    try {
      const file = path.join(dir, 'clawboo.db')
      const first = createDb(file)
      on(first)
      const r = propose({}, first)
      if (r.status !== 'proposed') throw new Error('not proposed')
      expect(accept(r.question.id, {}, first).ok).toBe(true)
      expect(stepsOf(first)).toHaveLength(3)
      first.$client.close()
      const second = createDb(file)
      expect(accept(r.question.id, {}, second)).toMatchObject({ ok: false, reason: 'answered' })
      expect(stepsOf(second)).toHaveLength(3)
      expect(propose({}, second)).toMatchObject({ status: 'already_accepted' })
      expect(stepsOf(second)).toHaveLength(3)
      second.$client.close()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('a failure part way leaves nothing: no steps, and the question still open', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    const client = db.$client
    client.exec(`
      CREATE TRIGGER boom BEFORE INSERT ON tasks
      WHEN NEW.title = 'Fix what fails'
      BEGIN SELECT RAISE(ABORT, 'boom'); END;
    `)
    expect(() => accept(r.question.id)).toThrow(/boom/)
    client.exec('DROP TRIGGER boom')
    expect(stepsOf()).toEqual([])
    expect(listTaskQuestions(db, r.task.id)[0]?.status).toBe('pending')
    expect(getTaskDocument(db, r.task.id, 'plan')?.decision).toBeNull()
    expect(accept(r.question.id).ok).toBe(true)
    expect(stepsOf()).toHaveLength(3)
  })

  it('more than the most steps is refused whole, and the question stays open', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    const many = Array.from({ length: DEFAULT_MAX_PLAN_STEPS + 1 }, (_, i) => ({ title: `s${i}` }))
    expect(accept(r.question.id, { tasks: many })).toMatchObject({
      ok: false,
      reason: 'too_many_steps',
    })
    expect(stepsOf()).toEqual([])
    expect(listTaskQuestions(db, r.task.id)[0]?.status).toBe('pending')
  })

  it('an empty list is not an acceptance', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(accept(r.question.id, { tasks: [] })).toMatchObject({
      ok: false,
      reason: 'invalid_answer',
    })
    expect(listTaskQuestions(db, r.task.id)[0]?.status).toBe('pending')
  })

  it('steps go under the task that proposed them', () => {
    const id = claimed()
    const r = propose({ taskId: id, agentId: 'a2' })
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = accept(r.question.id)
    if (!a.ok) throw new Error(a.reason)
    expect(a.created!.every((t) => t.parentTaskId === id)).toBe(true)
    // Its answer clears the wait: the wake moves it on.
    expect(getTask(db, id)?.waitingOn).toBeNull()
  })

  it('a card of its own holds no steps: they go where a plan’s steps go', () => {
    const parent = createTask(db, { title: 'Finished work', teamId: 'T' })
    const r = propose({ parentTaskId: parent.id })
    if (r.status !== 'proposed') throw new Error('not proposed')
    // The card itself files beside them, so a request's work stays together.
    expect(r.task.parentTaskId).toBe(parent.id)
    const a = accept(r.question.id)
    if (!a.ok) throw new Error(a.reason)
    expect(a.created!.every((t) => t.parentTaskId === parent.id)).toBe(true)
  })

  it('the card holding the plan does not take the slot of the plan’s last step', () => {
    const parent = createTask(db, { title: 'Finished work', teamId: 'T' })
    for (let i = 0; i < 21; i += 1)
      createTask(db, { title: `child ${i}`, teamId: 'T', parentTaskId: parent.id })
    const r = propose({ parentTaskId: parent.id })
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(accept(r.question.id).ok).toBe(true)
  })

  it('refuses steps the parent has no room for, whole', () => {
    const id = claimed()
    const r = propose({ taskId: id, agentId: 'a2' })
    if (r.status !== 'proposed') throw new Error('not proposed')
    for (let i = 0; i < 22; i += 1)
      createTask(db, { title: `child ${i}`, teamId: 'T', parentTaskId: id })
    expect(accept(r.question.id)).toMatchObject({ ok: false, reason: 'no_room', room: 2 })
    expect(stepsOf()).toEqual([])
    // Fewer steps fit.
    expect(accept(r.question.id, { tasks: STEPS.slice(0, 2) }).ok).toBe(true)
    expect(stepsOf()).toHaveLength(2)
  })

  it('honours a person’s edits, and gives a target nobody proposed to the proposer', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = accept(r.question.id, {
      tasks: [
        { title: 'Only the login tests', agentId: 'a3' },
        { title: 'One more', agentId: 'stranger' },
      ],
    })
    if (!a.ok) throw new Error(a.reason)
    expect(a.created!.map((t) => t.title)).toEqual(['Only the login tests', 'One more'])
    expect(a.created![0]!.sourceDelegationId).toContain(':agent:a3:')
    expect(a.created![1]!.sourceDelegationId).toContain(':agent:lead:')
  })

  it('a step already open with the same words is not made twice, and holds its place', () => {
    const open = createTask(db, {
      title: 'Fix what fails',
      teamId: 'T',
      status: 'todo',
      sourceDelegationId: 'r:deleg:agent:a4:reflectTo:lead',
    })
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = accept(r.question.id)
    if (!a.ok) throw new Error(a.reason)
    expect(a.created!.map((t) => t.title)).toEqual(['Run the tests', 'Run the tests again'])
    expect(a.linked?.map((t) => t.id)).toEqual([open.id])
    const third = a.created![1]!
    expect(getDependencies(db, third.id).map((d) => d.id)).toEqual([open.id])
    expect(getDependencies(db, open.id).map((d) => d.id)).toEqual([a.created![0]!.id])
  })

  it('a plan’s own repeated step is two tasks', () => {
    const r = propose({
      steps: [
        { title: 'Run the tests', agentId: 'a3' },
        { title: 'Fix', agentId: 'a4' },
        { title: 'Run the tests', agentId: 'a3' },
      ],
    })
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = accept(r.question.id)
    if (!a.ok) throw new Error(a.reason)
    expect(a.created).toHaveLength(3)
  })

  it('stays in the room the plan came from', () => {
    const r = propose({ roomId: 'room-2' })
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = accept(r.question.id)
    if (!a.ok) throw new Error(a.reason)
    expect(a.created!.every((t) => t.roomId === 'room-2')).toBe(true)
  })

  it('a plan the agent asked about again after it was accepted changes nothing', () => {
    const id = claimed()
    const r = propose({ taskId: id, agentId: 'a2' })
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(accept(r.question.id).ok).toBe(true)
    expect(propose({ taskId: id, agentId: 'a2', turnId: 'turn-2' })).toMatchObject({
      status: 'already_accepted',
    })
    expect(stepsOf()).toHaveLength(3)
  })
})

describe('turning a plan down', () => {
  beforeEach(() => on())

  it('creates nothing and keeps the person’s reason', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = answerQuestion(db, r.question.id, { accepted: false, note: 'Too much' }, person)
    expect(a.ok).toBe(true)
    if (!a.ok) return
    expect(a.created ?? []).toEqual([])
    expect(stepsOf()).toEqual([])
    expect(JSON.parse(a.question.answer ?? '{}')).toMatchObject({
      accepted: false,
      note: 'Too much',
    })
    expect(getTaskDocument(db, r.task.id, 'plan')?.decision).toBe('declined')
  })

  it('the same plan, asked again on that task, is refused', () => {
    const id = claimed()
    const r = propose({ taskId: id, agentId: 'a2' })
    if (r.status !== 'proposed') throw new Error('not proposed')
    answerQuestion(db, r.question.id, { accepted: false }, person)
    expect(propose({ taskId: id, agentId: 'a2', turnId: 'turn-2' })).toMatchObject({
      status: 'already_declined',
    })
    expect(listTaskQuestions(db, id)).toHaveLength(1)
  })

  it('a changed plan after a refusal asks again, as a new revision', () => {
    const id = claimed()
    const r = propose({ taskId: id, agentId: 'a2' })
    if (r.status !== 'proposed') throw new Error('not proposed')
    answerQuestion(db, r.question.id, { accepted: false }, person)
    const next = propose({ taskId: id, agentId: 'a2', turnId: 't2', steps: STEPS.slice(0, 1) })
    expect(next).toMatchObject({ status: 'proposed', revision: 2 })
  })
})

describe('the way out', () => {
  beforeEach(() => on())

  it.each(['cancelled', 'todo'] as const)(
    'a person moving the card to %s closes the plan, and accepting it then creates nothing',
    (to) => {
      const id = claimed()
      const r = propose({ taskId: id, agentId: 'a2' })
      if (r.status !== 'proposed') throw new Error('not proposed')
      expect(updateStatus(db, id, to, { actor: 'person' }).ok).toBe(true)
      expect(accept(r.question.id)).toMatchObject({ ok: false, reason: 'expired' })
      expect(stepsOf()).toEqual([])
    },
  )

  it('a Stop closes a plan on its own card: cancelled, nothing started', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(closeWaitingPlans(db, { teamId: 'T' })).toHaveLength(1)
    const q = listTaskQuestions(db, r.task.id)[0]!
    expect(q.status).toBe('expired')
    expect(q.closeReason).toBe('stopped')
    expect(getTask(db, r.task.id)?.status).toBe('cancelled')
    expect(attentionForTask(db, r.task.id)).toBeNull()
    expect(accept(q.id)).toMatchObject({ ok: false, reason: 'expired' })
    expect(stepsOf()).toEqual([])
    // Its revision stays readable.
    expect(getTaskDocument(db, r.task.id, 'plan')?.body).toContain('Run the tests')
  })

  it('a Stop closes a plan on a task: it goes back as stopped, and the pump leaves it', () => {
    const id = claimed()
    const r = propose({ taskId: id, agentId: 'a2' })
    if (r.status !== 'proposed') throw new Error('not proposed')
    closeWaitingPlans(db, { teamId: 'T' })
    expect(getTask(db, id)?.status).toBe('todo')
    expect(attentionForTask(db, id)?.reason).toBe('stopped')
    expect(accept(r.question.id)).toMatchObject({ ok: false, reason: 'expired' })
  })

  it('a Stop leaves an ordinary question alone, and another room’s plan', () => {
    const r = propose({ roomId: 'room-2' })
    expect(closeWaitingPlans(db, { teamId: 'T', roomId: null })).toEqual([])
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(listTaskQuestions(db, r.task.id)[0]?.status).toBe('pending')
  })

  it('writes an event when a Stop closes one, so an alert stops being owed', () => {
    propose()
    const before = db.select().from(orchestrationEvents).all().length
    closeWaitingPlans(db, { teamId: 'T' })
    expect(db.select().from(orchestrationEvents).all().length).toBeGreaterThan(before)
  })
})

describe('the table', () => {
  it('a plan’s holder is a real task row with a readable id', () => {
    on()
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    const row = db.select().from(tasks).all()[0]!
    expect(row.title).toContain('Run the tests')
    expect(row.description).toMatch(/do not hand them out again/i)
  })
})

describe('the switch goes off while a plan waits', () => {
  beforeEach(() => on())
  const off = (): void => setSetting(db, planApprovalSettingKey('T'), JSON.stringify({ on: false }))

  it('the waiting plan stays answerable until a plan starts without asking', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    off()
    expect(listTaskQuestions(db, r.task.id)[0]?.status).toBe('pending')
    expect(accept(r.question.id).ok).toBe(true)
  })

  it('a plan that starts without asking closes the one waiting, so it cannot run twice', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    off()
    expect(propose({ turnId: 'turn-2' })).toEqual({ status: 'off' })
    const q = listTaskQuestions(db, r.task.id)[0]!
    expect(q.status).toBe('expired')
    expect(q.closeReason).toBe('replaced')
    expect(getTask(db, r.task.id)?.status).toBe('cancelled')
    expect(attentionForTask(db, r.task.id)).toBeNull()
    expect(accept(q.id)).toMatchObject({ ok: false, reason: 'expired' })
    expect(stepsOf()).toEqual([])
    const notes = db.select().from(taskComments).where(eq(taskComments.taskId, r.task.id)).all()
    expect(notes.some((c) => /without asking/.test(c.body))).toBe(true)
    // What the alerts follow.
    const events = db.select().from(orchestrationEvents).all()
    expect(events.some((e) => e.data?.includes('"reason":"plan_replaced"'))).toBe(true)
  })

  it('leaves another agent’s waiting plan and another room’s alone', () => {
    const theirs = propose({ agentId: 'other' })
    const roomed = propose({ roomId: 'room-2' })
    if (theirs.status !== 'proposed' || roomed.status !== 'proposed') throw new Error('no')
    off()
    expect(propose({ turnId: 'turn-2' })).toEqual({ status: 'off' })
    expect(listTaskQuestions(db, theirs.task.id)[0]?.status).toBe('pending')
    expect(listTaskQuestions(db, roomed.task.id)[0]?.status).toBe('pending')
  })
})

describe('a plan with no task of its own, once answered', () => {
  beforeEach(() => on())

  it('accepted: its card is done, runs nothing, and the proposer gets a durable update', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = answerQuestion(db, r.question.id, { accepted: true, note: 'Go on' }, person)
    if (!a.ok) throw new Error(a.reason)
    expect(getTask(db, r.task.id)?.status).toBe('done')
    expect(attentionForTask(db, r.task.id)).toBeNull()
    const [row, ...more] = listPendingReportUps(db, 'T', null)
    expect(more).toEqual([])
    expect(row?.recipientAgentId).toBe('lead')
    const item = JSON.parse(row!.payload) as Record<string, string>
    expect(item['outcome']).toBe('plan_accepted')
    expect(item['toAgentId']).toBe('lead')
    expect(item['summary']).toMatch(/^Accepted the plan/)
    expect(item['summary']).toContain('Note: Go on')
  })

  it('turned down: its card is cancelled, and the update carries why', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = answerQuestion(db, r.question.id, { accepted: false, note: 'Too much' }, person)
    if (!a.ok) throw new Error(a.reason)
    expect(getTask(db, r.task.id)?.status).toBe('cancelled')
    const item = JSON.parse(listPendingReportUps(db, 'T', null)[0]!.payload) as Record<
      string,
      string
    >
    expect(item['outcome']).toBe('plan_declined')
    expect(item['summary']).toContain('Too much')
  })

  it('goes to the room the plan came from', () => {
    const r = propose({ roomId: 'room-2' })
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(accept(r.question.id).ok).toBe(true)
    expect(listPendingReportUps(db, 'T', 'room-2')).toHaveLength(1)
    expect(listPendingReportUps(db, 'T', null)).toEqual([])
  })

  it('a refused acceptance writes no update and leaves the card waiting', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    const tooMany = Array.from({ length: DEFAULT_MAX_PLAN_STEPS + 1 }, (_, i) => ({
      title: `s${i}`,
    }))
    expect(accept(r.question.id, { tasks: tooMany }).ok).toBe(false)
    expect(listPendingReportUps(db, 'T', null)).toEqual([])
    expect(getTask(db, r.task.id)?.status).toBe('blocked')
  })

  it('a plan on the run’s own task writes no update: its own session gets the wake', () => {
    const id = claimed()
    const r = propose({ taskId: id, agentId: 'a2' })
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(accept(r.question.id).ok).toBe(true)
    expect(listPendingReportUps(db, 'T', null)).toEqual([])
    expect(getTask(db, id)?.status).toBe('blocked')
  })
})

describe('the same plan from a later turn', () => {
  beforeEach(() => on())

  it('accepted: nothing new, however the turn differs', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(accept(r.question.id).ok).toBe(true)
    const steps = stepsOf().length
    const again = propose({ turnId: 'turn-2' })
    expect(again).toMatchObject({ status: 'already_accepted', taskId: r.task.id })
    expect(again).not.toHaveProperty('replay')
    expect(listTasks(db, { teamId: 'T' })).toHaveLength(1 + steps)
    expect(listTaskQuestions(db, r.task.id)).toHaveLength(1)
  })

  it('turned down: nothing new either', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    answerQuestion(db, r.question.id, { accepted: false }, person)
    expect(propose({ turnId: 'turn-2' })).toMatchObject({
      status: 'already_declined',
      taskId: r.task.id,
    })
    expect(listTasks(db, { teamId: 'T' })).toHaveLength(1)
  })

  it('recognises the list the person accepted, as well as the one proposed', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    const edited = [{ title: 'Only the login tests', agentId: 'a3' }]
    expect(accept(r.question.id, { tasks: edited }).ok).toBe(true)
    expect(propose({ turnId: 'turn-2', steps: edited })).toMatchObject({
      status: 'already_accepted',
    })
  })

  it('a different plan still asks', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(accept(r.question.id).ok).toBe(true)
    expect(propose({ turnId: 'turn-2', steps: STEPS.slice(0, 1) }).status).toBe('proposed')
  })

  it('another agent’s or another room’s answer does not speak for this one', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(accept(r.question.id).ok).toBe(true)
    expect(propose({ turnId: 't2', agentId: 'other' }).status).toBe('proposed')
    expect(propose({ turnId: 't3', roomId: 'room-2' }).status).toBe('proposed')
  })

  it('asks again once the answer is old', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(accept(r.question.id).ok).toBe(true)
    db.update(taskQuestions)
      .set({ answeredAt: Date.now() - SAME_TASK_WINDOW_MS - 1 })
      .where(eq(taskQuestions.id, r.question.id))
      .run()
    expect(propose({ turnId: 'turn-2' }).status).toBe('proposed')
  })

  it('a routine’s next fire is a new request, not a repeat', () => {
    const id = claimed({ scheduledBy: 'clawboo' })
    const r = propose({ taskId: id, agentId: 'a2' })
    if (r.status !== 'proposed') throw new Error('not proposed')
    expect(accept(r.question.id).ok).toBe(true)
    const next = claimed({ scheduledBy: 'clawboo' })
    expect(propose({ taskId: next, agentId: 'a2', turnId: 'turn-2' }).status).toBe('proposed')
  })
})

describe('a plan that takes another’s place', () => {
  beforeEach(() => on())

  it('the card’s title follows the plan it now holds', () => {
    const first = propose()
    if (first.status !== 'proposed') throw new Error('not proposed')
    const migration = [{ title: 'Migrate the database', agentId: 'a3' }]
    const next = propose({ turnId: 'turn-2', steps: migration })
    if (next.status !== 'proposed') throw new Error('not proposed')
    expect(getTask(db, first.task.id)?.title).toBe('Plan: Migrate the database')
  })

  it('says what it replaced: to the person on the card, and to the caller', () => {
    const first = propose()
    if (first.status !== 'proposed') throw new Error('not proposed')
    const next = propose({ turnId: 'turn-2', steps: STEPS.slice(0, 1) })
    if (next.status !== 'proposed') throw new Error('not proposed')
    expect(next.replaced?.title).toBe(first.task.title)
    expect(parseQuestionPayload(next.question.payload)?.prompt).toMatch(/takes the place/)
    expect(parseQuestionPayload(next.question.payload)?.prompt).toContain('revision 1')
    const notes = db.select().from(taskComments).where(eq(taskComments.taskId, first.task.id)).all()
    expect(notes.some((c) => c.body.includes(first.task.title))).toBe(true)
  })

  it('a first plan replaces nothing', () => {
    const first = propose()
    if (first.status !== 'proposed') throw new Error('not proposed')
    expect(first.replaced).toBeUndefined()
  })

  it('on the run’s own task, the task keeps its title', () => {
    const id = claimed()
    propose({ taskId: id, agentId: 'a2' })
    propose({ taskId: id, agentId: 'a2', turnId: 'turn-2', steps: STEPS.slice(0, 1) })
    expect(getTask(db, id)?.title).toBe('Ship it')
  })
})

describe('what a person accepts is what runs', () => {
  beforeEach(() => on())

  it('a long step reaches its task whole', () => {
    const long = `${'a'.repeat(250)} the end`
    const r = propose({
      steps: [{ title: long.slice(0, 200), description: long, agentId: 'a3' }],
    })
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = accept(r.question.id)
    if (!a.ok) throw new Error(a.reason)
    expect(a.created?.[0]?.description).toBe(long)
  })

  it('what a person cut from a step does not reach its task', () => {
    const long = `${'a'.repeat(200)} and then delete the database`
    const r = propose({
      steps: [{ title: long.slice(0, 200), description: long, agentId: 'a3' }],
    })
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = accept(r.question.id, { tasks: [{ title: 'Only this', agentId: 'a3' }] })
    if (!a.ok) throw new Error(a.reason)
    expect(a.created?.[0]?.title).toBe('Only this')
    expect(a.created?.[0]?.description).toBeNull()
  })

  it('a person’s own long words are not cut', () => {
    const long = `${'p'.repeat(300)} the end`
    const r = propose()
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = accept(r.question.id, { tasks: [{ title: long }] })
    if (!a.ok) throw new Error(a.reason)
    expect(a.created?.[0]?.description).toBe(long)
  })
})

describe('a batch of hand-offs', () => {
  beforeEach(() => on())

  it('accepted, every one is ready at once: no chain', () => {
    const r = propose({ parallel: true })
    if (r.status !== 'proposed') throw new Error('not proposed')
    const a = accept(r.question.id)
    if (!a.ok) throw new Error(a.reason)
    for (const made of a.created!) expect(getDependencies(db, made.id)).toEqual([])
    expect(getReadyTasks(db, { teamId: 'T' })).toHaveLength(3)
  })
})

describe('who a plan’s writes say made them', () => {
  beforeEach(() => on())

  it('a document records its agent and its run', () => {
    const id = claimed()
    expect(
      writeTaskDocument(db, { taskId: id, agentId: 'a2', body: 'Plan', executionId: 'e1' }),
    ).toMatchObject({ ok: true, revision: 1 })
    expect(getTaskDocument(db, id)).toMatchObject({ authorAgentId: 'a2', executionId: 'e1' })
    expect(listTaskDocumentRevisions(db, id)[0]?.executionId).toBe('e1')
  })

  it('a proposal records them on the question, the revision and the event', () => {
    const id = claimed()
    const r = propose({ taskId: id, agentId: 'a2', executionId: 'e1' })
    if (r.status !== 'proposed') throw new Error(r.status)
    expect(r.question.executionId).toBe('e1')
    expect(getTaskDocument(db, id)?.executionId).toBe('e1')
    const event = db
      .select()
      .from(orchestrationEvents)
      .all()
      .find((e) => e.kind === 'status_changed' && e.data.includes('"plan":true'))
    expect(JSON.parse(event!.data)).toMatchObject({
      actor: { kind: 'agent', agentId: 'a2', execId: 'e1' },
    })
  })

  it('a turn with no run says it has none', () => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error(r.status)
    expect(r.question.executionId).toBeNull()
  })
})

describe('a card that only holds a plan never runs', () => {
  beforeEach(() => on())
  const held = (): { taskId: string; questionId: string } => {
    const r = propose()
    if (r.status !== 'proposed') throw new Error(r.status)
    return { taskId: r.task.id, questionId: r.question.id }
  }

  it.each([
    ['proposed', () => undefined],
    ['accepted', (q: string) => answerQuestion(db, q, { accepted: true }, person)],
    ['turned down', (q: string) => answerQuestion(db, q, { accepted: false }, person)],
    ['closed by a Stop', () => closeWaitingPlans(db, { teamId: 'T' })],
  ])('%s: its ledger stays empty', (_name, act) => {
    const { taskId, questionId } = held()
    act(questionId)
    expect(listExecutions(db, taskId)).toEqual([])
  })
})

describe('what a Stop writes for a plan on the run’s own task', () => {
  beforeEach(() => on())

  it('the cancelled run it leaves is the engine’s, not someone else’s', () => {
    const id = claimed()
    expect(propose({ taskId: id, agentId: 'a2' }).status).toBe('proposed')
    closeWaitingPlans(db, { teamId: 'T' })
    const last = listExecutions(db, id).at(-1)!
    expect(last.status).toBe('cancelled')
    expect(isEngineRun(last)).toBe(true)
    expect(getTask(db, id)?.status).toBe('todo')
  })
})

describe('what a task waiting on its sub-tasks reads a plan’s card as', () => {
  beforeEach(() => on())

  /** A task whose run closed, waiting on its sub-tasks, with a plan on a card under it. */
  const waitingWithCard = (wait: { kind: 'subtasks'; handedOut?: true }) => {
    const parent = claimed()
    updateStatus(db, parent, 'blocked', { waitingOn: wait })
    const r = propose({ parentTaskId: parent })
    if (r.status !== 'proposed') throw new Error(r.status)
    expect(r.task.parentTaskId).toBe(parent)
    return { parent, card: r.task.id, question: r.question.id }
  }

  it('the engine’s wait does not hold for it', () => {
    const { parent } = waitingWithCard({ kind: 'subtasks', handedOut: true })
    releaseOneSubtaskWait(db, parent)
    expect(getTask(db, parent)?.status).toBe('todo')
  })

  it('an agent’s own wait holds until it is answered, and then for the steps it made', () => {
    const { parent, question } = waitingWithCard({ kind: 'subtasks' })
    releaseOneSubtaskWait(db, parent)
    expect(getTask(db, parent)?.status).toBe('blocked')
    expect(answerQuestion(db, question, { accepted: true }, person).ok).toBe(true)
    expect(getTask(db, parent)?.status).toBe('blocked')
    const views = subtaskViewsOf(db, parent)
    expect(views).toHaveLength(4)
    expect(views.filter((v) => v.status === 'todo')).toHaveLength(3)
  })

  it('turned down, an agent’s own wait is over, because nothing more is coming', () => {
    const { parent, question } = waitingWithCard({ kind: 'subtasks' })
    expect(answerQuestion(db, question, { accepted: false }, person).ok).toBe(true)
    expect(getTask(db, parent)?.status).toBe('todo')
  })

  it('a card holds no steps: they go beside it, under the task', () => {
    const { parent, card, question } = waitingWithCard({ kind: 'subtasks' })
    answerQuestion(db, question, { accepted: true }, person)
    expect(subtaskViewsOf(db, card)).toEqual([])
    expect(
      listTasks(db, { teamId: 'T' }).filter((t) => t.parentTaskId === parent && t.id !== card),
    ).toHaveLength(3)
  })
})
