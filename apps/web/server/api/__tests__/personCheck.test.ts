// The same person check on every person write: a move, Retry, Assign, an approval
// answer and a team's work check. A caller that is not the dashboard's page, and
// that no sign-in proxy vouched for, never gets the person's authority: Retry,
// Assign, approval answers and the work check refuse it, and a move still happens
// but without the authority. A speed bump locally (see actsAsPerson), so what is
// pinned is that no caller gets the authority by accident or by a body field.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  approvalHistory,
  claimTask,
  createApproval,
  createTask,
  getApproval,
  getComments,
  getSetting,
  getTask,
  listEvents,
  listExecutions,
  listGovernanceAudit,
  listTasks,
  setTaskVerification,
  teams,
  updateStatus,
} from '@clawboo/db'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const dispatched: string[] = []
vi.mock('../../lib/teamChat/boardDispatch', () => ({
  requestTaskDispatch: (_teamId: string, taskId: string) => {
    dispatched.push(taskId)
  },
}))
const humanMoves: string[] = []
vi.mock('../../lib/teamChat/humanMove', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/teamChat/humanMove')>()),
  noteHumanMove: (_db: unknown, move: { taskId: string }) => {
    humanMoves.push(move.taskId)
  },
}))

// The worktree's own work is covered with worktrees; here, who may ask for it and
// what the route records.
vi.mock('../../lib/worktrees', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/worktrees')>()),
  actOnTaskWorkspace: async (taskId: string) => {
    const { getDb: db } = await import('../../lib/db')
    claimTask(db(), taskId, 'coder')
    updateStatus(db(), taskId, 'done')
    return { ok: true, action: 'complete', complete: {}, taskStatus: 'done' }
  },
}))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const {
  boardAssignPOST,
  boardCommentPOST,
  boardCreatePOST,
  boardExecutionCreatePOST,
  boardRetryPOST,
  boardUpdatePATCH,
  boardWorkspaceActionPATCH,
} = await import('../board')
const { toolsApprovalResolvePOST } = await import('../tools')
const { capabilitiesActionPOST } = await import('../capabilities')
const { approvalsPOST } = await import('../approvals')
const { teamVerifyCommandPUT } = await import('../teamVerifyCommand')
const { teamVerifyCommandSettingKey } = await import('../../lib/verification/teamVerifyCommand')

const TEAM = 'T'
const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const ADA = { id: 'user-42', name: 'Ada', role: 'admin' }

/** Every caller that must not get the person's authority. */
const NOT_THE_PERSON: Array<[string, Record<string, string>]> = [
  ['a CLI or curl', {}],
  ["Node's fetch", { 'sec-fetch-mode': 'cors' }],
  ['another site', { 'sec-fetch-site': 'cross-site', 'sec-fetch-mode': 'cors' }],
  ['a link', { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'navigate' }],
]

function mockRes() {
  let status = 200
  let payload: unknown
  const res = {
    status(c: number) {
      status = c
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, code: () => status, body: () => payload as Record<string, unknown> }
}

const req = (over: {
  params?: Record<string, string>
  body?: unknown
  headers?: Record<string, string>
  person?: typeof ADA | null
}): Request =>
  ({
    params: {},
    query: {},
    body: {},
    headers: {},
    person: null,
    app: { locals: {} },
    ...over,
  }) as unknown as Request

function statusEvents(taskId: string): Array<Record<string, unknown>> {
  return listEvents(getDb(), { limit: 1000 })
    .filter((e) => e.kind === 'status_changed' && e.taskId === taskId)
    .map((e) => JSON.parse(e.data) as Record<string, unknown>)
}

function boundTask(status: 'todo' | 'blocked' = 'blocked') {
  const db = getDb()
  const t = createTask(db, {
    title: 'stuck',
    teamId: TEAM,
    sourceDelegationId: 'r1:deleg:agent:coder:reflectTo:lead',
  })
  if (status === 'blocked') updateStatus(db, t.id, 'blocked')
  return getTask(db, t.id)!
}

let home: string
const prev: Record<string, string | undefined> = {}
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-person-check-'))
  await mkdir(path.join(home, '.clawboo'), { recursive: true })
  for (const name of ['HOME', 'CLAWBOO_HOME']) {
    prev[name] = process.env[name]
    process.env[name] = home
  }
  expect(getDbPath().startsWith(home)).toBe(true)
  dispatched.length = 0
  humanMoves.length = 0
  const db = getDb()
  const now = Date.now()
  db.insert(teams)
    .values({ id: TEAM, name: 'Team', icon: 'x', color: 'x', createdAt: now, updatedAt: now })
    .run()
  db.insert(agents)
    .values({
      id: 'coder',
      name: 'Coder',
      gatewayId: 'coder',
      teamId: TEAM,
      createdAt: now,
      updatedAt: now,
    })
    .run()
})
afterEach(async () => {
  resetDb()
  for (const name of ['HOME', 'CLAWBOO_HOME']) {
    if (prev[name] === undefined) delete process.env[name]
    else process.env[name] = prev[name]
  }
  await rm(home, { recursive: true, force: true })
})

describe.each(NOT_THE_PERSON)('from %s', (_name, headers) => {
  it('Retry is refused, and writes nothing', () => {
    const t = boundTask()
    const r = mockRes()
    boardRetryPOST(req({ params: { taskId: t.id }, headers }), r.res)
    expect(r.code()).toBe(403)
    expect(r.body()['error']).toBe('person_only')
    expect(getTask(getDb(), t.id)?.status).toBe('blocked')
    expect(getComments(getDb(), t.id)).toEqual([])
    expect(dispatched).toEqual([])
  })

  it('a task cannot be created for an agent, though one with no agent can', () => {
    const before = listTasks(getDb()).length
    const refused = mockRes()
    boardCreatePOST(
      req({ body: { title: 'for you', teamId: TEAM, assigneeAgentId: 'coder' }, headers }),
      refused.res,
    )
    expect(refused.code()).toBe(403)
    expect(refused.body()['error']).toBe('person_only')
    expect(listTasks(getDb())).toHaveLength(before)
    expect(dispatched).toEqual([])

    const plain = mockRes()
    boardCreatePOST(req({ body: { title: 'open', teamId: TEAM }, headers }), plain.res)
    expect(plain.code()).toBe(200)
    expect(listTasks(getDb())).toHaveLength(before + 1)
    const [event] = listEvents(getDb(), { kinds: ['task_created'] })
    expect((JSON.parse(event!.data) as Record<string, unknown>)['actor']).toEqual({
      kind: 'caller',
    })
  })

  it.each([
    ['a person', 'assign:x:agent:coder:origin:human'],
    ['an agent to fire', 'r1:deleg:agent:coder'],
    ['who hears the result', 'r1:deleg:reflectTo:lead'],
    ['a person, with no agent', 'origin:human'],
  ])('a sourceDelegationId naming %s is refused', (_what, sourceDelegationId) => {
    const before = listTasks(getDb()).length
    const r = mockRes()
    boardCreatePOST(req({ body: { title: 'x', teamId: TEAM, sourceDelegationId }, headers }), r.res)
    expect(r.code()).toBe(403)
    expect(listTasks(getDb())).toHaveLength(before)
    expect(dispatched).toEqual([])
  })

  it('a sourceDelegationId that names no one is kept', () => {
    const r = mockRes()
    boardCreatePOST(
      req({ body: { title: 'x', teamId: TEAM, sourceDelegationId: 'import:row-7' }, headers }),
      r.res,
    )
    expect(r.code()).toBe(200)
  })

  it('completing a workspace is refused, and moves nothing', async () => {
    const t = boundTask('todo')
    const r = mockRes()
    await boardWorkspaceActionPATCH(
      req({ params: { taskId: t.id }, body: { action: 'complete' }, headers }),
      r.res,
    )
    expect(r.code()).toBe(403)
    expect(r.body()['error']).toBe('person_only')
    expect(getTask(getDb(), t.id)?.status).toBe('todo')
  })

  it('a run cannot be opened to end a person’s hold on the card', () => {
    const t = boundTask('todo')
    updateStatus(getDb(), t.id, 'blocked', { actor: 'person' })
    const opened = mockRes()
    boardExecutionCreatePOST(
      req({ params: { taskId: t.id }, body: { executorType: 'script' }, headers }),
      opened.res,
    )
    expect(opened.code()).toBe(409)
    expect(opened.body()['error']).toBe('person_moved')
    expect(listExecutions(getDb(), t.id)).toEqual([])
    const moved = mockRes()
    boardUpdatePATCH(
      req({ params: { taskId: t.id }, body: { status: 'todo' }, headers }),
      moved.res,
    )
    expect(moved.code()).toBe(409)
    expect(getTask(getDb(), t.id)?.status).toBe('blocked')
  })

  it('a run can still be opened on a task no person moved', () => {
    const t = boundTask('todo')
    const r = mockRes()
    boardExecutionCreatePOST(
      req({ params: { taskId: t.id }, body: { executorType: 'script' }, headers }),
      r.res,
    )
    expect(r.code()).toBe(200)
    expect(listExecutions(getDb(), t.id)).toHaveLength(1)
  })

  it('a moved card says it moved without a person’s authority', () => {
    const t = boundTask('todo')
    const r = mockRes()
    boardUpdatePATCH(req({ params: { taskId: t.id }, body: { status: 'blocked' }, headers }), r.res)
    expect(r.body()['byPerson']).toBe(false)
  })

  it('a reply that did not pass as a person says so', async () => {
    const t = boundTask('todo')
    const r = mockRes()
    await boardCommentPOST(
      req({ params: { taskId: t.id }, body: { body: 'hi', authorType: 'user' }, headers }),
      r.res,
    )
    expect(r.body()['byPerson']).toBe(false)
  })

  it('Assign is refused, and writes nothing', () => {
    const t = boundTask()
    const r = mockRes()
    boardAssignPOST(req({ params: { taskId: t.id }, body: { agentId: 'coder' }, headers }), r.res)
    expect(r.code()).toBe(403)
    expect(r.body()['error']).toBe('person_only')
    expect(getTask(getDb(), t.id)).toMatchObject({
      status: 'blocked',
      sourceDelegationId: t.sourceDelegationId,
    })
    expect(dispatched).toEqual([])
  })

  it('an approval cannot be answered, on either route', async () => {
    const a = createApproval(getDb(), { toolName: 'x', agentId: 'coder', args: {} })
    const viaTools = mockRes()
    await toolsApprovalResolvePOST(
      req({ params: { id: a.id }, body: { decision: 'allow_once' }, headers }),
      viaTools.res,
    )
    expect(viaTools.code()).toBe(403)
    const viaCapabilities = mockRes()
    await capabilitiesActionPOST(
      req({
        params: { action: 'approve' },
        body: { id: a.id, decision: 'allow_once' },
        headers,
      }),
      viaCapabilities.res,
    )
    expect(viaCapabilities.code()).toBe(403)
    expect(getApproval(getDb(), a.id)?.status).toBe('pending')
  })

  it('cannot put a decision in the approval history', async () => {
    const r = mockRes()
    await approvalsPOST(
      req({ body: { agentId: 'coder', action: 'allow-once', toolName: 'exec' }, headers }),
      r.res,
    )
    expect(r.code()).toBe(403)
    expect(getDb().select().from(approvalHistory).all()).toEqual([])
  })

  it("cannot change a team's work check", () => {
    const r = mockRes()
    teamVerifyCommandPUT(
      req({ params: { teamId: TEAM }, body: { command: 'true' }, headers }),
      r.res,
    )
    expect(r.code()).toBe(403)
    expect(getSetting(getDb(), teamVerifyCommandSettingKey(TEAM))).toBeFalsy()
    expect(listGovernanceAudit(getDb(), { eventType: 'verification' })).toEqual([])
  })

  it('a move happens, without the authority of a person', () => {
    const t = boundTask('todo')
    claimTask(getDb(), t.id, 'coder')
    const r = mockRes()
    boardUpdatePATCH(req({ params: { taskId: t.id }, body: { status: 'blocked' }, headers }), r.res)
    expect(r.code()).toBe(200)
    const after = getTask(getDb(), t.id)
    expect(after?.status).toBe('blocked')
    // Not a person's move: a later agent write is not overruled by it, the run is
    // not stopped, and the record does not say a person did it.
    expect(after?.personMovedAt).toBeNull()
    expect(humanMoves).toEqual([])
    const [event] = statusEvents(t.id)
    expect(event).toMatchObject({ to: 'blocked', actor: { kind: 'caller' } })
    expect(event).not.toHaveProperty('by')
  })

  it('a move cannot overrule a person who moved the card', () => {
    const t = boundTask('todo')
    updateStatus(getDb(), t.id, 'blocked', { actor: 'person' })
    const r = mockRes()
    boardUpdatePATCH(req({ params: { taskId: t.id }, body: { status: 'todo' }, headers }), r.res)
    expect(r.code()).toBe(409)
    expect(r.body()['error']).toBe('person_moved')
    expect(getTask(getDb(), t.id)?.status).toBe('blocked')
  })

  it('a move cannot use the override past a failing check', () => {
    const t = boundTask('todo')
    claimTask(getDb(), t.id, 'coder')
    setFailingVerdict(t.id)
    const r = mockRes()
    boardUpdatePATCH(
      req({ params: { taskId: t.id }, body: { status: 'done', humanOverride: true }, headers }),
      r.res,
    )
    expect(r.code()).toBe(409)
    expect(r.body()['error']).toBe('verification_required')
    expect(getTask(getDb(), t.id)?.status).toBe('in_progress')
    expect(listGovernanceAudit(getDb(), { eventType: 'verification' })).toEqual([])
  })

  it("a comment is an agent's, even when it claims to be the person's or clawboo's", async () => {
    const t = boundTask('todo')
    for (const authorType of ['user', 'system']) {
      const r = mockRes()
      await boardCommentPOST(
        req({ params: { taskId: t.id }, body: { body: 'hi', authorType }, headers }),
        r.res,
      )
      expect(r.code()).toBe(200)
    }
    expect(getComments(getDb(), t.id).map((c) => c.authorType)).toEqual(['agent', 'agent'])
    const actors = listEvents(getDb(), { limit: 1000 })
      .filter((e) => e.kind === 'comment_added')
      .map((e) => (JSON.parse(e.data) as Record<string, unknown>)['actor'])
    expect(actors).toEqual([{ kind: 'caller' }, { kind: 'caller' }])
  })
})

function setFailingVerdict(taskId: string): void {
  setTaskVerification(getDb(), taskId, {
    status: 'fail',
    attempts: [
      {
        attempt: 1,
        at: Date.now(),
        deterministic: {
          command: 'pnpm test',
          exitCode: 1,
          passed: false,
          stdoutTail: '',
          stderrTail: '',
          durationMs: 12,
          timedOut: false,
        },
        critic: {
          ran: false,
          findings: [],
          reviewerRuntime: null,
          reviewerModel: null,
          reviewedSha: null,
        },
        status: 'fail',
        structuredError: null,
      },
    ],
    debtNotes: [],
    updatedAt: Date.now(),
  })
}

/** Every caller that does get it: the dashboard's page, the dashboard on a plain
 *  http network address, and a person a sign-in proxy vouched for. */
const THE_PERSON: Array<[string, Partial<Parameters<typeof req>[0]>]> = [
  ['the dashboard', { headers: DASHBOARD }],
  [
    'the dashboard over plain http on a network address',
    { headers: { origin: 'http://192.168.1.10:18790', host: '192.168.1.10:18790' } },
  ],
  ['a person a sign-in proxy vouched for', { person: ADA }],
]

describe.each(THE_PERSON)('from %s', (_name, who) => {
  it('a sourceDelegationId naming an agent is kept', () => {
    const r = mockRes()
    boardCreatePOST(
      req({
        body: { title: 'x', teamId: TEAM, sourceDelegationId: 'r1:deleg:agent:coder' },
        ...who,
      }),
      r.res,
    )
    expect(r.code()).toBe(200)
  })

  it('a moved card and a reply do not say otherwise', async () => {
    const t = boundTask('todo')
    const moved = mockRes()
    boardUpdatePATCH(
      req({ params: { taskId: t.id }, body: { status: 'blocked' }, ...who }),
      moved.res,
    )
    expect(moved.body()).not.toHaveProperty('byPerson')
    const replied = mockRes()
    await boardCommentPOST(
      req({ params: { taskId: t.id }, body: { body: 'hi', authorType: 'user' }, ...who }),
      replied.res,
    )
    expect(replied.body()).not.toHaveProperty('byPerson')
  })

  it('a run can be opened after their own move', () => {
    const t = boundTask('todo')
    updateStatus(getDb(), t.id, 'blocked', { actor: 'person' })
    const r = mockRes()
    boardExecutionCreatePOST(
      req({ params: { taskId: t.id }, body: { executorType: 'script' }, ...who }),
      r.res,
    )
    expect(r.code()).toBe(200)
  })

  it('a worktree can be completed, and the move is on record with who asked', async () => {
    const t = boundTask('todo')
    const r = mockRes()
    await boardWorkspaceActionPATCH(
      req({ params: { taskId: t.id }, body: { action: 'complete' }, ...who }),
      r.res,
    )
    expect(r.code()).toBe(200)
    expect(statusEvents(t.id).at(-1)).toMatchObject({
      to: 'done',
      reason: 'workspace_complete',
      actor: { kind: 'person' },
    })
  })

  it('a task can be created for an agent, and starts', () => {
    const r = mockRes()
    boardCreatePOST(
      req({ body: { title: 'for you', teamId: TEAM, assigneeAgentId: 'coder' }, ...who }),
      r.res,
    )
    expect(r.code()).toBe(200)
    expect(dispatched).toHaveLength(1)
  })

  it('Retry runs the task', () => {
    const t = boundTask()
    const r = mockRes()
    boardRetryPOST(req({ params: { taskId: t.id }, ...who }), r.res)
    expect(r.code()).toBe(202)
    expect(getTask(getDb(), t.id)?.status).toBe('todo')
    expect(getComments(getDb(), t.id).map((c) => c.authorType)).toEqual(['user'])
    expect(dispatched).toEqual([t.id])
    expect(statusEvents(t.id)[0]).toMatchObject({ reason: 'retry', actor: { kind: 'person' } })
  })

  it('Assign starts the task', () => {
    const t = boundTask()
    const r = mockRes()
    boardAssignPOST(req({ params: { taskId: t.id }, body: { agentId: 'coder' }, ...who }), r.res)
    expect(r.code()).toBe(200)
    expect(dispatched).toEqual([t.id])
    expect(statusEvents(t.id)[0]).toMatchObject({ reason: 'assigned', actor: { kind: 'person' } })
  })

  it('an approval is answered', async () => {
    const a = createApproval(getDb(), { toolName: 'x', agentId: 'coder', args: {} })
    const r = mockRes()
    await toolsApprovalResolvePOST(
      req({ params: { id: a.id }, body: { decision: 'deny' }, ...who }),
      r.res,
    )
    expect(r.code()).toBe(200)
    expect(getApproval(getDb(), a.id)?.status).toBe('deny')
  })

  it("a team's work check changes, on record", () => {
    const r = mockRes()
    teamVerifyCommandPUT(
      req({ params: { teamId: TEAM }, body: { command: 'true' }, ...who }),
      r.res,
    )
    expect(r.code()).toBe(200)
    const [row] = listGovernanceAudit(getDb(), { eventType: 'verification' })
    expect(JSON.parse(row!.summary)).toMatchObject({ command: 'true', actor: { kind: 'person' } })
  })

  it('a move is a person’s: it stops the run and can pass the check', () => {
    const t = boundTask('todo')
    claimTask(getDb(), t.id, 'coder')
    setFailingVerdict(t.id)
    const r = mockRes()
    boardUpdatePATCH(
      req({ params: { taskId: t.id }, body: { status: 'done', humanOverride: true }, ...who }),
      r.res,
    )
    expect(r.code()).toBe(200)
    const after = getTask(getDb(), t.id)
    expect(after?.status).toBe('done')
    expect(after?.personMovedAt).not.toBeNull()
    expect(humanMoves).toEqual([t.id])
    expect(statusEvents(t.id)[0]).toMatchObject({
      to: 'done',
      by: 'person',
      actor: { kind: 'person' },
    })
  })

  it('a comment is the person’s', async () => {
    const t = boundTask('todo')
    const r = mockRes()
    await boardCommentPOST(
      req({ params: { taskId: t.id }, body: { body: 'hi', authorType: 'user' }, ...who }),
      r.res,
    )
    // A note on how it was delivered may follow it.
    expect(getComments(getDb(), t.id)[0]?.authorType).toBe('user')
  })
})

describe('a person a sign-in proxy vouched for', () => {
  it('is named on the trail Retry and Assign leave', () => {
    const retried = boundTask()
    boardRetryPOST(req({ params: { taskId: retried.id }, person: ADA }), mockRes().res)
    expect(JSON.parse(getComments(getDb(), retried.id)[0]!.person ?? 'null')).toEqual(ADA)
    const assigned = boundTask()
    boardAssignPOST(
      req({ params: { taskId: assigned.id }, body: { agentId: 'coder' }, person: ADA }),
      mockRes().res,
    )
    expect(JSON.parse(getComments(getDb(), assigned.id)[0]!.person ?? 'null')).toEqual(ADA)
  })

  it('is named on what they did, beside the actor', () => {
    const t = boundTask('todo')
    claimTask(getDb(), t.id, 'coder')
    const r = mockRes()
    boardUpdatePATCH(
      req({ params: { taskId: t.id }, body: { status: 'blocked' }, person: ADA }),
      r.res,
    )
    expect(statusEvents(t.id)[0]).toMatchObject({ person: ADA, actor: { kind: 'person' } })
  })
})
