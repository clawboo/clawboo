// Plans on the board, as the routes serve them: the per-team switch, the plan document
// and its revisions, and a person's answer to a waiting plan. Run in a sandboxed home.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { isEngineRun } from '@clawboo/board-core'
import {
  addComment,
  attentionForTask,
  claimTask,
  closeWaitingPlans,
  createTask,
  getComments,
  getTask,
  listExecutions,
  listGovernanceAudit,
  listPendingReportUps,
  listTaskQuestions,
  listTasks,
  listWaitingTaskWakes,
  LOCAL_READER,
  orchestrationEvents,
  taskReadStates,
  planApprovalOn,
  planApprovalSettingKey,
  proposePlan,
  setSetting,
  settings,
  teams,
  writeTaskDocument,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { stopAsOwnWrite } from '../../lib/boardReader'
import { getDb, getDbPath, resetDb } from '../../lib/db'
import {
  resolveServerOrchestrated,
  serverOrchestratedSettingKey,
} from '../../lib/teamChat/resolveServerOrchestrated'
import { resetTeamOrchestrators } from '../../lib/teamChat/teamOrchestrator'
import { boardPlanGET } from '../boardPlan'
import { boardQuestionAnswerPOST } from '../boardPerson'
import { teamChatStopPOST, teamsDELETE } from '../teams'
import { teamPlanApprovalGET, teamPlanApprovalPUT } from '../teamPlanApproval'

const TEAM = 'T'
const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }

function mockRes(): { res: Response; statusCode: () => number; body: () => Record<string, never> } {
  let code = 200
  let payload: unknown
  const res = {
    status(c: number) {
      code = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, statusCode: () => code, body: () => payload as Record<string, never> }
}

const req = (over: Partial<Request> = {}): Request =>
  ({
    params: {},
    query: {},
    headers: DASHBOARD,
    body: {},
    socket: { localPort: 0 },
    get: () => undefined,
    ...over,
  }) as unknown as Request

describe('plans on the board', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-plan-route-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    resetDb()
    expect(getDbPath().startsWith(home)).toBe(true)
    const now = Date.now()
    getDb()
      .insert(teams)
      .values({
        id: TEAM,
        name: 'Team',
        icon: '🚀',
        color: '#e94560',
        leaderAgentId: 'lead',
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    resetTeamOrchestrators()
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  const switchOn = (): void =>
    setSetting(getDb(), planApprovalSettingKey(TEAM), JSON.stringify({ on: true }))

  const STEPS = [
    { title: 'Run the tests', agentId: 'a2', agentName: 'Bug Boo' },
    { title: 'Fix what fails', agentId: 'a3', agentName: 'Design Boo' },
  ]

  const proposed = () => {
    switchOn()
    const r = proposePlan(getDb(), {
      teamId: TEAM,
      agentId: 'lead',
      prompt: 'Lead proposes a plan of 2 steps.',
      steps: STEPS,
      taskId: null,
      parentTaskId: null,
      turnId: 'turn-1',
    })
    if (r.status !== 'proposed') throw new Error(`not proposed: ${r.status}`)
    return r
  }

  const answer = async (questionId: string, body: Record<string, unknown>) => {
    const m = mockRes()
    await boardQuestionAnswerPOST(req({ params: { questionId }, body: { answer: body } }), m.res)
    return m
  }

  describe('the switch', () => {
    const put = (body: unknown, over: Partial<Request> = {}) => {
      const m = mockRes()
      teamPlanApprovalPUT(req({ params: { teamId: TEAM }, body, ...over }), m.res)
      return m
    }

    it('is off at first', () => {
      const m = mockRes()
      teamPlanApprovalGET(req({ params: { teamId: TEAM } }), m.res)
      expect(m.body()).toEqual({ on: false })
    })

    it('a person turns it on and off, and each change is on record', () => {
      expect(put({ on: true }).body()).toEqual({ on: true })
      expect(planApprovalOn(getDb(), TEAM)).toBe(true)
      expect(put({ on: false }).body()).toEqual({ on: false })
      expect(planApprovalOn(getDb(), TEAM)).toBe(false)
      const audit = listGovernanceAudit(getDb(), { eventType: 'board' })
      expect(audit.filter((a) => /set_team_plan_approval/.test(String(a.summary)))).toHaveLength(2)
    })

    it('a caller nothing vouches for cannot flip it, and nothing goes on record', () => {
      const m = put({ on: true }, { headers: {} })
      expect(m.statusCode()).toBe(403)
      expect(m.body()).toMatchObject({ ok: false, error: 'person_only' })
      expect(planApprovalOn(getDb(), TEAM)).toBe(false)
      expect(listGovernanceAudit(getDb(), { limit: 10 })).toEqual([])
    })

    it('a person a sign-in proxy vouched for can, from a script, and the record names them', () => {
      const ada = { id: 'user-42', name: 'Ada', role: 'admin' }
      const m = put({ on: true }, { headers: {}, person: ada } as Partial<Request>)
      expect(m.statusCode()).toBe(200)
      expect(planApprovalOn(getDb(), TEAM)).toBe(true)
      const [row] = listGovernanceAudit(getDb(), { limit: 10 })
      expect(JSON.parse(row!.summary!)).toMatchObject({
        action: 'set_team_plan_approval',
        on: true,
        actor: { kind: 'person' },
        person: ada,
      })
    })

    it('refuses anything but a yes or no, and a team that is not there', () => {
      expect(put({ on: 'yes' }).statusCode()).toBe(400)
      const m = mockRes()
      teamPlanApprovalPUT(req({ params: { teamId: 'nope' }, body: { on: true } }), m.res)
      expect(m.statusCode()).toBe(404)
    })

    it('goes when its team goes', async () => {
      put({ on: true })
      const m = mockRes()
      await teamsDELETE(req({ params: { id: TEAM } }), m.res)
      const db = getDb()
      expect(
        db
          .select()
          .from(settings)
          .where(eq(settings.key, planApprovalSettingKey(TEAM)))
          .get(),
      ).toBeUndefined()
    })
  })

  describe('GET /api/board/:taskId/plan', () => {
    const planOf = (taskId: string, query: Record<string, string> = {}) => {
      const m = mockRes()
      boardPlanGET(req({ params: { taskId }, query }), m.res)
      return m
    }

    const withPlan = (): string => {
      const db = getDb()
      const t = createTask(db, { title: 'Ship', teamId: TEAM })
      claimTask(db, t.id, 'a2')
      writeTaskDocument(db, { taskId: t.id, agentId: 'a2', body: 'First idea' })
      writeTaskDocument(db, { taskId: t.id, agentId: 'a2', body: 'Better idea' })
      return t.id
    }

    it('serves the newest, and lists the older ones without their bodies', () => {
      const body = planOf(withPlan()).body() as unknown as {
        plan: { revision: number; body: string }
        revisions: Array<{ revision: number; body?: string; chars: number }>
      }
      expect(body.plan).toMatchObject({ revision: 2, body: 'Better idea' })
      expect(body.revisions.map((r) => r.revision)).toEqual([2, 1])
      expect(body.revisions[1]).toMatchObject({ chars: 'First idea'.length })
      expect(body.revisions[1]).not.toHaveProperty('body')
    })

    it('serves an older revision after a newer one', () => {
      const body = planOf(withPlan(), { revision: '1' }).body() as unknown as {
        plan: { body: string }
      }
      expect(body.plan.body).toBe('First idea')
    })

    it('says so when a task has no plan, a revision is not there, or the task is not', () => {
      const t = createTask(getDb(), { title: 'Bare', teamId: TEAM })
      expect(planOf(t.id).body()).toEqual({ plan: null, revisions: [] })
      expect(planOf(withPlan(), { revision: '9' }).statusCode()).toBe(404)
      expect(planOf(withPlan(), { revision: 'x' }).statusCode()).toBe(400)
      expect(planOf('nope').statusCode()).toBe(404)
    })
  })

  describe('answering a plan', () => {
    it('shows in Needs you as a question, with an event for the alerts', () => {
      const r = proposed()
      expect(attentionForTask(getDb(), r.task.id)?.reason).toBe('question')
      const events = getDb().select().from(orchestrationEvents).all()
      expect(
        events.some((e) => e.kind === 'status_changed' && e.data?.includes('"plan":true')),
      ).toBe(true)
    })

    it('an agent cannot accept: no dashboard fetch metadata, nothing created', async () => {
      const r = proposed()
      const m = mockRes()
      await boardQuestionAnswerPOST(
        req({
          params: { questionId: r.question.id },
          headers: {},
          body: { answer: { accepted: true } },
        }),
        m.res,
      )
      expect(m.statusCode()).toBe(403)
      expect(listTasks(getDb(), { teamId: TEAM })).toHaveLength(1)
      expect(listTaskQuestions(getDb(), r.task.id)[0]?.status).toBe('pending')
    })

    it('accepting makes the steps once; pressing it twice is refused and makes nothing', async () => {
      const r = proposed()
      const first = await answer(r.question.id, { accepted: true })
      expect(first.statusCode()).toBe(200)
      expect(first.body()).toMatchObject({ ok: true, created: 2 })
      expect(listTasks(getDb(), { teamId: TEAM })).toHaveLength(3)
      const second = await answer(r.question.id, { accepted: true })
      expect(second.statusCode()).toBe(409)
      expect(second.body()).toMatchObject({ error: 'answered' })
      expect(listTasks(getDb(), { teamId: TEAM })).toHaveLength(3)
    })

    it('after a restart, it still makes nothing more', async () => {
      const r = proposed()
      await answer(r.question.id, { accepted: true })
      resetDb()
      const second = await answer(r.question.id, { accepted: true })
      expect(second.statusCode()).toBe(409)
      expect(listTasks(getDb(), { teamId: TEAM })).toHaveLength(3)
    })

    it('the thread says the tasks exist, and the lead hears through an update, not a run', async () => {
      const r = proposed()
      const m = await answer(r.question.id, { accepted: true, note: 'Go on' })
      expect(m.body()).toMatchObject({ delivery: { status: 'queued', reason: 'next-run' } })
      const words = getComments(getDb(), r.task.id).map((c) => c.body)
      expect(words.some((w) => /^Accepted the plan/.test(w) && /Note: Go on/.test(w))).toBe(true)
      expect(words.some((w) => /Create these tasks/.test(w))).toBe(false)
      expect(listWaitingTaskWakes(getDb(), { taskId: r.task.id })).toEqual([])
      expect(getTask(getDb(), r.task.id)?.status).toBe('done')
      const [row] = listPendingReportUps(getDb(), TEAM, null)
      expect(row?.recipientAgentId).toBe('lead')
      expect(row?.payload).toContain('plan_accepted')
    })

    it('on the run’s own task, the agent is woken in the session that proposed it', async () => {
      switchOn()
      const db = getDb()
      const t = createTask(db, {
        title: 'Ship',
        teamId: TEAM,
        status: 'todo',
        sourceDelegationId: 'r:deleg:agent:a2:reflectTo:lead',
      })
      claimTask(db, t.id, 'a2')
      const r = proposePlan(db, {
        teamId: TEAM,
        agentId: 'a2',
        prompt: 'A plan.',
        steps: STEPS,
        taskId: t.id,
        parentTaskId: null,
      })
      if (r.status !== 'proposed') throw new Error('not proposed')
      await answer(r.question.id, { accepted: true })
      expect(listWaitingTaskWakes(db, { taskId: t.id }).map((w) => w.reason)).toEqual([
        'question_answered',
      ])
      expect(listPendingReportUps(db, TEAM, null)).toEqual([])
    })

    it('each new step is announced in the event log, as a person’s doing', async () => {
      const r = proposed()
      await answer(r.question.id, { accepted: true })
      const created = getDb()
        .select()
        .from(orchestrationEvents)
        .all()
        .filter((e) => e.kind === 'task_created')
      expect(created.length).toBeGreaterThanOrEqual(2)
      for (const e of created) expect(JSON.parse(e.data).actor, e.data).toEqual({ kind: 'person' })
    })

    it.each([
      ['accepted', true, 'done'],
      ['turned down', false, 'cancelled'],
    ])('%s, the card’s close is in the event log as a person’s move', async (_n, accepted, to) => {
      const r = proposed()
      await answer(r.question.id, { accepted })
      const closed = getDb()
        .select()
        .from(orchestrationEvents)
        .all()
        .filter((e) => e.kind === 'status_changed' && e.taskId === r.task.id)
        .map((e) => JSON.parse(e.data) as Record<string, unknown>)
        .find((d) => d['reason'] === 'plan_answered')
      expect(closed).toMatchObject({ to, actor: { kind: 'person' } })
    })

    it('the question’s words on the thread stay the agent’s, under the run that asked', async () => {
      switchOn()
      const db = getDb()
      const t = createTask(db, {
        title: 'Ship',
        teamId: TEAM,
        status: 'todo',
        sourceDelegationId: 'r:deleg:agent:a2:reflectTo:lead',
      })
      claimTask(db, t.id, 'a2')
      const r = proposePlan(db, {
        teamId: TEAM,
        agentId: 'a2',
        prompt: 'A plan.',
        steps: STEPS,
        taskId: t.id,
        parentTaskId: null,
        executionId: 'exec-7',
      })
      if (r.status !== 'proposed') throw new Error('not proposed')
      await answer(r.question.id, { accepted: true })
      const asked = getComments(db, t.id).find((c) => c.authorType === 'agent')
      expect(asked).toMatchObject({ authorAgentId: 'a2', executionId: 'exec-7' })
    })

    describe('a person’s answer is their own write', () => {
      const unread = (id: string): boolean | undefined =>
        taskReadStates(getDb(), LOCAL_READER).get(id)?.unread

      it('accepted: the card and the steps it made read as read, until someone else acts', async () => {
        const r = proposed()
        expect(unread(r.task.id)).toBe(true)
        await answer(r.question.id, { accepted: true })
        expect(unread(r.task.id)).toBe(false)
        const steps = listTasks(getDb(), { teamId: TEAM }).filter((t) => t.id !== r.task.id)
        expect(steps).toHaveLength(2)
        for (const step of steps) expect(unread(step.id), step.title).toBe(false)
        addComment(getDb(), steps[0]!.id, 'On it.', 'agent', 'a2', { kind: 'agent' })
        expect(unread(steps[0]!.id)).toBe(true)
      })

      it('turned down: the card reads as read', async () => {
        const r = proposed()
        await answer(r.question.id, { accepted: false })
        expect(unread(r.task.id)).toBe(false)
      })

      it('a refused answer reads nothing, and makes nothing', async () => {
        const r = proposed()
        const m = mockRes()
        await boardQuestionAnswerPOST(
          req({
            params: { questionId: r.question.id },
            headers: {},
            body: { answer: { accepted: true } },
          }),
          m.res,
        )
        expect(m.statusCode()).toBe(403)
        expect(unread(r.task.id)).toBe(true)
      })
    })

    it('turning it down makes nothing, and the update carries why', async () => {
      const r = proposed()
      const m = await answer(r.question.id, { accepted: false, note: 'Too much at once' })
      expect(m.body()).toMatchObject({ ok: true, created: 0 })
      expect(listTasks(getDb(), { teamId: TEAM })).toHaveLength(1)
      expect(getComments(getDb(), r.task.id).some((c) => /Too much at once/.test(c.body))).toBe(
        true,
      )
      expect(listWaitingTaskWakes(getDb(), { taskId: r.task.id })).toEqual([])
      expect(getTask(getDb(), r.task.id)?.status).toBe('cancelled')
      expect(listPendingReportUps(getDb(), TEAM, null)[0]?.payload).toContain('Too much at once')
    })

    it('too many steps is refused whole, with the question left open', async () => {
      const r = proposed()
      const tasks = Array.from({ length: 26 }, (_, i) => ({ title: `s${i}` }))
      const m = await answer(r.question.id, { accepted: true, tasks })
      expect(m.statusCode()).toBe(400)
      expect(m.body()).toMatchObject({ error: 'too_many_steps' })
      expect(listTasks(getDb(), { teamId: TEAM })).toHaveLength(1)
      expect(listTaskQuestions(getDb(), r.task.id)[0]?.status).toBe('pending')
    })
  })

  describe('a Stop', () => {
    it('closes a waiting plan even when no engine is up to hear it', () => {
      const r = proposed()
      const db = getDb()
      setSetting(db, serverOrchestratedSettingKey(TEAM), 'true')
      expect(resolveServerOrchestrated(db, TEAM)).toBe(true)
      const m = mockRes()
      teamChatStopPOST(req({ params: { id: TEAM }, body: {} }), m.res)
      expect(m.statusCode()).toBe(200)
      expect(listTaskQuestions(db, r.task.id)[0]?.closeReason).toBe('stopped')
      expect(getTask(db, r.task.id)?.status).toBe('cancelled')
      // The person's own Stop: it does not come back to them as news.
      expect(taskReadStates(db, LOCAL_READER).get(r.task.id)?.unread).toBe(false)
    })

    it('on the run’s own task it reads as stopped, and as read, and it was the engine’s run', () => {
      switchOn()
      const db = getDb()
      setSetting(db, serverOrchestratedSettingKey(TEAM), 'true')
      const t = createTask(db, {
        title: 'Ship',
        teamId: TEAM,
        status: 'todo',
        sourceDelegationId: 'r:deleg:agent:a2:reflectTo:lead',
      })
      claimTask(db, t.id, 'a2')
      expect(
        proposePlan(db, {
          teamId: TEAM,
          agentId: 'a2',
          prompt: 'A plan.',
          steps: STEPS,
          taskId: t.id,
          parentTaskId: null,
        }).status,
      ).toBe('proposed')
      teamChatStopPOST(req({ params: { id: TEAM }, body: {} }), mockRes().res)
      expect(getTask(db, t.id)?.status).toBe('todo')
      expect(attentionForTask(db, t.id)?.reason).toBe('stopped')
      expect(isEngineRun(listExecutions(db, t.id).at(-1)!)).toBe(true)
      expect(taskReadStates(db, LOCAL_READER).get(t.id)?.unread).toBe(false)
    })

    it('with an engine up, a person’s Stop is their own write too', async () => {
      const r = proposed()
      const db = getDb()
      setSetting(db, serverOrchestratedSettingKey(TEAM), 'true')
      await stopAsOwnWrite(db, LOCAL_READER, { teamId: TEAM, roomId: null }, async () => {
        closeWaitingPlans(db, { teamId: TEAM, roomId: null })
      })
      expect(getTask(db, r.task.id)?.status).toBe('cancelled')
      expect(taskReadStates(db, LOCAL_READER).get(r.task.id)?.unread).toBe(false)
    })
  })
})
