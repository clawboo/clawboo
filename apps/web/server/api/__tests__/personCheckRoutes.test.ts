// The routes other builds added take the one person check too: Reopen, assign to a
// person, answering a question, the card about agents waking each other and a team's
// always allow, a team's switch for asking before a plan starts, a team's letters and labels,
// a task's labels, read marks, and pausing and resuming. A person a sign-in proxy vouched for passes it from a script; a caller nothing
// vouches for gets `person_only`. And what they write says who did it.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  addComment,
  agents,
  askQuestion,
  claimTask,
  createLabel,
  createRoom,
  createTask,
  getComments,
  getGrant,
  getRoom,
  getSetting,
  getTask,
  handBackTask,
  linkDep,
  listEvents,
  listGovernanceAudit,
  listGrants,
  listPauses,
  listPendingChatReportUps,
  listPendingReportUps,
  listTaskQuestions,
  openAgentWakeCard,
  placePause,
  planApprovalSettingKey,
  proposePlan,
  readAgentWakeGate,
  readTeamAlwaysAllow,
  revokeGrant,
  saveAgentCommentWake,
  setBudgetLimit,
  setSetting,
  teams,
  updateStatus,
  upsertGrant,
} from '@clawboo/db'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../../lib/teamChat/boardDispatch', () => ({
  requestTaskDispatch: () => undefined,
  pumpRoomOfTask: () => undefined,
}))
vi.mock('../../lib/runnerRerun', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../lib/runnerRerun')>()),
  requestRunnerRerun: () => undefined,
}))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const { onChatReportUp } = await import('../../lib/agentChat/chatReportUpOutbox')
const { boardCommentPOST, boardCreatePOST, boardTaskLabelsPUT, boardUpdatePATCH } =
  await import('../board')
const { boardAgentWakesPOST, boardAssignPersonPOST, boardQuestionAnswerPOST, boardReopenPOST } =
  await import('../boardPerson')
const { teamAgentWakesPUT } = await import('../teamAgentWakes')
const { teamPlanApprovalPUT } = await import('../teamPlanApproval')
const { boardInboxReadPOST, boardTaskReadPOST } = await import('../boardInbox')
const { teamLabelDELETE, teamLabelPATCH, teamLabelsPOST, teamTaskPrefixPUT } =
  await import('../teamLabels')
const { pausesDELETE, pausesPOST } = await import('../pauses')
const { teamAgentDELETE, teamAgentPOST, teamChatStopPOST, teamsDELETE, teamsPATCH } =
  await import('../teams')
const { teamRoomDELETE } = await import('../rooms')
const { agentMovePOST, agentsCleanupPOST, agentsCreatePOST, agentsDELETE, agentsSyncPOST } =
  await import('../agents')
const { execSettingsPOST } = await import('../execSettings')
const { execAllowlistRevokePOST } = await import('../execAllowlist')
const { nativeShellPOST } = await import('../nativeShell')
const { grantsCreatePOST, grantsResumePOST, grantsRevokePOST } = await import('../grants')
const { capabilitiesActionPOST } = await import('../capabilities')
const { approveDevicePOST, autoConfigureOpenclawPOST, configureOpenclawPOST, openclawConfigPATCH } =
  await import('../system')
const { resolveTeamLeadId } = await import('../../lib/teamChat/teamLead')
const { agentChatStopPOST } = await import('../agentChat')
const { teamRulesPUT } = await import('../teamRules')
const { teamOnboardingPATCH } = await import('../teamOnboarding')
const { booZeroOverridePOST } = await import('../booZeroOverride')
const { budgetsResumePOST, budgetsSetPOST } = await import('../budgets')
const { schedulesCreatePOST, schedulesDELETE, schedulesRunPOST, schedulesUpdatePATCH } =
  await import('../schedules')

const TEAM = 'T'
const DASHBOARD = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }
const ADA = { id: 'user-42', name: 'Ada', role: 'admin' }
const AGENT_RUN = { kind: 'agent', agentId: 'coder', execId: 'exec-1' }

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
    get: () => undefined,
    socket: {},
    ...over,
  }) as unknown as Request

function eventsOf(kind: string, taskId: string): Array<Record<string, unknown>> {
  return listEvents(getDb(), { limit: 1000 })
    .filter((e) => e.kind === kind && e.taskId === taskId)
    .map((e) => JSON.parse(e.data) as Record<string, unknown>)
}

function doneTask(): string {
  const db = getDb()
  const t = createTask(db, { title: 'finished', teamId: TEAM })
  claimTask(db, t.id, 'coder')
  updateStatus(db, t.id, 'done')
  return t.id
}

function asked(): { taskId: string; questionId: string } {
  const db = getDb()
  const t = createTask(db, { title: 'asks', teamId: TEAM })
  claimTask(db, t.id, 'coder')
  const r = askQuestion(db, {
    taskId: t.id,
    agentId: 'coder',
    kind: 'question',
    payload: { prompt: 'Which one?' },
    executionId: 'exec-1',
  })
  if (!r.ok) throw new Error(r.reason)
  return { taskId: t.id, questionId: r.question.id }
}

/** A task with the card up: a teammate's comment would start its agent. */
function askingCard(): string {
  const db = getDb()
  const t = createTask(db, {
    title: 'parked',
    teamId: TEAM,
    sourceDelegationId: 'r1:deleg:agent:coder:reflectTo:lead',
  })
  claimTask(db, t.id, 'coder')
  updateStatus(db, t.id, 'blocked', { waitingOn: { kind: 'person', need: 'A key', by: 'agent' } })
  saveAgentCommentWake(
    db,
    t.id,
    addComment(db, t.id, 'Here it is', 'agent', 'helper', { kind: 'agent' }),
  )
  expect(
    openAgentWakeCard(db, {
      taskId: t.id,
      kind: 'ask',
      fromAgentId: 'helper',
      toAgentId: 'coder',
    }),
  ).toBe(true)
  return t.id
}

let home: string
const prev: Record<string, string | undefined> = {}
beforeEach(async () => {
  home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-person-routes-'))
  await mkdir(path.join(home, '.clawboo'), { recursive: true })
  for (const name of ['HOME', 'CLAWBOO_HOME']) {
    prev[name] = process.env[name]
    process.env[name] = home
  }
  expect(getDbPath().startsWith(home)).toBe(true)
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

const ROUTINE = {
  source: 'clawboo-routine',
  domain: 'team-task',
  agentId: 'coder',
  cronSpec: '0 9 * * 1',
  label: 'Weekly report',
}

/** A routine the person made, to act on: its id. */
async function routine(): Promise<string> {
  const r = mockRes()
  await schedulesCreatePOST(req({ body: ROUTINE, headers: DASHBOARD }), r.res)
  return (r.body()['schedule'] as { id: string }).id
}

/** Every person-only route, and how to call it as `who`. */
type Who = { headers?: Record<string, string>; person?: typeof ADA | null }
const ROUTES: Array<[string, (who: Who, res: Response) => unknown]> = [
  [
    "a team's rules",
    (who, res) =>
      teamRulesPUT(req({ params: { teamId: TEAM }, body: { content: 'Be brief.' }, ...who }), res),
  ],
  [
    'what a person tells a team about themselves',
    (who, res) =>
      teamOnboardingPATCH(
        req({ params: { id: TEAM }, body: { userIntroText: 'I am Ada.' }, ...who }),
        res,
      ),
  ],
  [
    'who leads as Boo Zero',
    (who, res) => booZeroOverridePOST(req({ body: { agentId: 'coder' }, ...who }), res),
  ],
  [
    "stopping a team's chat",
    (who, res) => teamChatStopPOST(req({ params: { id: TEAM }, ...who }), res),
  ],
  [
    'stopping a one-to-one chat',
    (who, res) => agentChatStopPOST(req({ params: { agentId: 'coder' }, ...who }), res),
  ],
  [
    'archiving a team',
    (who, res) =>
      teamsPATCH(req({ params: { id: TEAM }, body: { isArchived: true }, ...who }), res),
  ],
  [
    'changing who leads a team',
    (who, res) =>
      teamsPATCH(req({ params: { id: TEAM }, body: { leaderAgentId: 'coder' }, ...who }), res),
  ],
  [
    'setting a budget',
    (who, res) =>
      budgetsSetPOST(
        req({ body: { scope: 'team', scopeId: TEAM, limitUsdCents: 500 }, ...who }),
        res,
      ),
  ],
  [
    'resuming a budget',
    (who, res) => {
      setBudgetLimit(getDb(), { scope: 'team', scopeId: TEAM, limitUsdCents: 500, mode: 'cap' })
      return budgetsResumePOST(req({ params: { scope: 'team', scopeId: TEAM }, ...who }), res)
    },
  ],
  ['making a routine', (who, res) => schedulesCreatePOST(req({ body: ROUTINE, ...who }), res)],
  [
    'changing a routine',
    async (who, res) =>
      schedulesUpdatePATCH(
        req({ params: { id: await routine() }, body: { action: 'pause' }, ...who }),
        res,
      ),
  ],
  [
    'firing a routine',
    async (who, res) => schedulesRunPOST(req({ params: { id: await routine() }, ...who }), res),
  ],
  [
    'deleting a routine',
    async (who, res) => schedulesDELETE(req({ params: { id: await routine() }, ...who }), res),
  ],
  [
    "a task's title",
    (who, res) => {
      const t = createTask(getDb(), { title: 'x', teamId: TEAM })
      return boardUpdatePATCH(req({ params: { taskId: t.id }, body: { title: 'y' }, ...who }), res)
    },
  ],
  [
    "a task's description",
    (who, res) => {
      const t = createTask(getDb(), { title: 'x', teamId: TEAM })
      return boardUpdatePATCH(
        req({ params: { taskId: t.id }, body: { description: 'do this instead' }, ...who }),
        res,
      )
    },
  ],
  ['Reopen', (who, res) => boardReopenPOST(req({ params: { taskId: doneTask() }, ...who }), res)],
  [
    'assign to a person',
    (who, res) => {
      const t = createTask(getDb(), { title: 'x', teamId: TEAM })
      return boardAssignPersonPOST(req({ params: { taskId: t.id }, ...who }), res)
    },
  ],
  [
    'answering a question',
    (who, res) =>
      boardQuestionAnswerPOST(
        req({
          params: { questionId: asked().questionId },
          body: { answer: { text: 'That one' } },
          ...who,
        }),
        res,
      ),
  ],
  [
    "a team's letters",
    (who, res) =>
      teamTaskPrefixPUT(req({ params: { id: TEAM }, body: { prefix: 'AB' }, ...who }), res),
  ],
  [
    'adding a label',
    (who, res) => teamLabelsPOST(req({ params: { id: TEAM }, body: { name: 'Bug' }, ...who }), res),
  ],
  [
    'renaming a label',
    (who, res) => {
      const made = createLabel(getDb(), TEAM, 'Old')
      if (!made.ok) throw new Error(made.reason)
      return teamLabelPATCH(
        req({ params: { id: TEAM, labelId: made.label.id }, body: { name: 'New' }, ...who }),
        res,
      )
    },
  ],
  [
    'removing a label',
    (who, res) => {
      const made = createLabel(getDb(), TEAM, 'Old')
      if (!made.ok) throw new Error(made.reason)
      return teamLabelDELETE(req({ params: { id: TEAM, labelId: made.label.id }, ...who }), res)
    },
  ],
  [
    "a task's labels",
    (who, res) => {
      const t = createTask(getDb(), { title: 'x', teamId: TEAM })
      return boardTaskLabelsPUT(
        req({ params: { taskId: t.id }, body: { labelIds: [] }, ...who }),
        res,
      )
    },
  ],
  [
    'marking a task read',
    (who, res) => {
      const t = createTask(getDb(), { title: 'x', teamId: TEAM })
      return boardTaskReadPOST(req({ params: { taskId: t.id }, body: { through: 1 }, ...who }), res)
    },
  ],
  [
    'marking the inbox read',
    (who, res) => boardInboxReadPOST(req({ body: { through: 1 }, ...who }), res),
  ],
  [
    'answering the card about agents waking each other',
    (who, res) =>
      boardAgentWakesPOST(
        req({ params: { jobTaskId: askingCard() }, body: { decision: 'no' }, ...who }),
        res,
      ),
  ],
  [
    "a team's always allow for agents waking each other",
    (who, res) =>
      teamAgentWakesPUT(req({ params: { teamId: TEAM }, body: { always: true }, ...who }), res),
  ],
  [
    "a team's switch for asking before a plan starts",
    (who, res) =>
      teamPlanApprovalPUT(req({ params: { teamId: TEAM }, body: { on: true }, ...who }), res),
  ],
  [
    'answering a plan',
    (who, res) => {
      setSetting(getDb(), planApprovalSettingKey(TEAM), JSON.stringify({ on: true }))
      const made = proposePlan(getDb(), {
        teamId: TEAM,
        agentId: 'lead',
        prompt: 'A plan.',
        steps: [{ title: 'One', agentId: 'coder' }],
        taskId: null,
        parentTaskId: null,
        turnId: `turn-${Math.random()}`,
      })
      if (made.status !== 'proposed') throw new Error(made.status)
      return boardQuestionAnswerPOST(
        req({
          params: { questionId: made.question.id },
          body: { answer: { accepted: true } },
          ...who,
        }),
        res,
      )
    },
  ],
  ['pausing', (who, res) => pausesPOST(req({ body: { kind: 'agent', id: 'coder' }, ...who }), res)],
  [
    'resuming',
    (who, res) => {
      placePause(getDb(), { kind: 'agent', id: 'coder' })
      return pausesDELETE(req({ params: { kind: 'agent', id: 'coder' }, ...who }), res)
    },
  ],
]

describe.each(ROUTES)('%s', (_name, call) => {
  it('refuses a caller nothing vouches for, with the one code', async () => {
    const r = mockRes()
    await call({}, r.res)
    expect(r.code()).toBe(403)
    expect(r.body()['error']).toBe('person_only')
  })

  it('takes a person a sign-in proxy vouched for, from a script with no fetch metadata', async () => {
    const r = mockRes()
    await call({ person: ADA }, r.res)
    expect(r.code()).toBeLessThan(300)
  })

  it('takes the dashboard’s own page', async () => {
    const r = mockRes()
    await call({ headers: DASHBOARD }, r.res)
    expect(r.code()).toBeLessThan(300)
  })
})

/** The other team, for what crosses from one to another. */
const OTHER = 'T2'
function otherTeam(): void {
  const now = Date.now()
  getDb()
    .insert(teams)
    .values({ id: OTHER, name: 'Other', icon: 'x', color: 'x', createdAt: now, updatedAt: now })
    .run()
}

const memberOf = (agentId: string): string | null | undefined =>
  getDb().select({ teamId: agents.teamId }).from(agents).where(eq(agents.id, agentId)).get()?.teamId

function grantForCoder() {
  return upsertGrant(getDb(), {
    subjectKind: 'agent',
    subjectId: 'coder',
    capabilityKind: 'connector',
    connectorId: 'conn-1',
    capabilityId: null,
    origin: 'operator',
  })
}

/** Routes whose person side touches the machine or a live Gateway: refused is what these
 *  pin. That the check lets a person through is pinned by the routes above. */
const REFUSED: Array<[string, (res: Response) => unknown]> = [
  ['deleting a team', (res) => teamsDELETE(req({ params: { id: TEAM } }), res)],
  [
    'archiving a room',
    (res) => {
      const room = createRoom(getDb(), { teamId: TEAM, name: 'Launch', memberIds: [] })
      return teamRoomDELETE(req({ params: { id: TEAM, roomId: room.id } }), res)
    },
  ],
  [
    'adding an agent to a team',
    (res) => teamAgentPOST(req({ params: { id: TEAM }, body: { agentId: 'coder' } }), res),
  ],
  [
    'taking an agent off a team',
    (res) => teamAgentDELETE(req({ params: { id: TEAM, agentId: 'coder' } }), res),
  ],
  [
    'moving an agent',
    (res) => agentMovePOST(req({ params: { agentId: 'coder' }, body: { teamId: TEAM } }), res),
  ],
  ['deleting an agent', (res) => agentsDELETE(req({ params: { agentId: 'coder' } }), res)],
  [
    'dropping agents a list leaves out',
    (res) => agentsCleanupPOST(req({ body: { liveAgentIds: ['nobody'] } }), res),
  ],
  [
    'archiving agents a list leaves out',
    (res) => agentsSyncPOST(req({ body: { agents: [] } }), res),
  ],
  [
    'an agent’s exec settings',
    (res) => execSettingsPOST(req({ body: { agentId: 'coder', values: { execAsk: 'off' } } }), res),
  ],
  [
    'an agent’s shell switch',
    (res) => nativeShellPOST(req({ params: { agentId: 'coder' }, body: { enabled: true } }), res),
  ],
  [
    'revoking a standing exec grant',
    (res) => execAllowlistRevokePOST(req({ body: { agentId: 'coder', keys: ['k'] } }), res),
  ],
  [
    'a grant that asks no one',
    (res) =>
      grantsCreatePOST(
        req({
          body: {
            subjectKind: 'agent',
            subjectId: 'coder',
            capabilityKind: 'connector',
            connectorId: 'conn-1',
            mode: 'admin',
            approvalPolicy: 'never',
          },
        }),
        res,
      ),
  ],
  ['revoking a grant', (res) => grantsRevokePOST(req({ params: { id: grantForCoder().id } }), res)],
  ['resuming a grant', (res) => grantsResumePOST(req({ params: { id: grantForCoder().id } }), res)],
  [
    'OpenClaw’s exec default',
    (res) => openclawConfigPATCH(req({ body: { exec: { ask: 'off' } } }), res),
  ],
  [
    'configuring OpenClaw',
    (res) => configureOpenclawPOST(req({ body: { provider: 'anthropic', apiKey: 'key' } }), res),
  ],
  ['configuring OpenClaw by itself', (res) => autoConfigureOpenclawPOST(req({}), res)],
  ['approving a device', (res) => approveDevicePOST(req({}), res)],
  [
    'enabling a capability',
    (res) => capabilitiesActionPOST(req({ params: { action: 'enable' }, body: { id: 'x' } }), res),
  ],
  [
    'disabling a capability',
    (res) => capabilitiesActionPOST(req({ params: { action: 'disable' }, body: { id: 'x' } }), res),
  ],
  [
    'an agent that starts on a team',
    (res) => agentsCreatePOST(req({ body: { name: 'New', teamId: TEAM } }), res),
  ],
  [
    'an OpenClaw agent with no ask set',
    (res) => agentsCreatePOST(req({ body: { name: 'New', execConfig: {} } }), res),
  ],
  [
    'an OpenClaw agent that is asked nothing',
    (res) => agentsCreatePOST(req({ body: { name: 'New', execConfig: { execAsk: 'off' } } }), res),
  ],
  [
    'a native agent with a shell',
    (res) =>
      agentsCreatePOST(
        req({
          body: {
            name: 'New',
            sourceId: 'clawboo-native',
            execConfig: { tools: { shell: true } },
          },
        }),
        res,
      ),
  ],
]

describe('a caller nothing vouches for', () => {
  it.each(REFUSED)('gets no say over %s', async (_name, call) => {
    const r = mockRes()
    await call(r.res)
    expect(r.code()).toBe(403)
    expect(r.body()['error']).toBe('person_only')
  })

  it('cannot delete a team: its agents stay on it, and no one’s request closes', async () => {
    const task = createTask(getDb(), { title: 'x', teamId: TEAM, status: 'todo' })
    const r = mockRes()
    await teamsDELETE(req({ params: { id: TEAM } }), r.res)
    expect(r.code()).toBe(403)
    expect(
      getDb()
        .select()
        .from(teams)
        .all()
        .map((t) => t.id),
    ).toEqual([TEAM])
    expect(memberOf('coder')).toBe(TEAM)
    expect(getTask(getDb(), task.id)?.status).toBe('todo')
    expect(listGovernanceAudit(getDb(), { limit: 10 })).toEqual([])
  })

  it('cannot archive a room: nothing about it changes', async () => {
    const room = createRoom(getDb(), { teamId: TEAM, name: 'Launch', memberIds: [] })
    await teamRoomDELETE(req({ params: { id: TEAM, roomId: room.id } }), mockRes().res)
    expect(getRoom(getDb(), room.id)?.archivedAt).toBeNull()
    expect(listGovernanceAudit(getDb(), { limit: 10 })).toEqual([])
  })

  it('cannot walk around a team’s lead: taking it off, moving it or deleting it', async () => {
    otherTeam()
    getDb().update(teams).set({ leaderAgentId: 'coder' }).where(eq(teams.id, TEAM)).run()
    const lead = (): string | null => resolveTeamLeadId(getDb(), TEAM)
    expect(lead()).toBe('coder')

    teamAgentDELETE(req({ params: { id: TEAM, agentId: 'coder' } }), mockRes().res)
    agentMovePOST(req({ params: { agentId: 'coder' }, body: { teamId: OTHER } }), mockRes().res)
    await agentsDELETE(req({ params: { agentId: 'coder' } }), mockRes().res)
    agentsCleanupPOST(req({ body: { liveAgentIds: ['nobody'] } }), mockRes().res)

    expect(memberOf('coder')).toBe(TEAM)
    expect(lead()).toBe('coder')
  })

  it('cannot turn off who is asked: the stored setting stays as it was', async () => {
    await execSettingsPOST(
      req({ body: { agentId: 'coder', values: { execAsk: 'off' } } }),
      mockRes().res,
    )
    const row = getDb().select().from(agents).where(eq(agents.id, 'coder')).get()
    expect(row?.execConfig ?? null).toBeNull()
  })

  it('cannot widen a grant: none is written', () => {
    const r = mockRes()
    grantsCreatePOST(
      req({
        body: {
          subjectKind: 'agent',
          subjectId: 'coder',
          capabilityKind: 'connector',
          connectorId: 'conn-1',
          mode: 'admin',
          approvalPolicy: 'never',
        },
      }),
      r.res,
    )
    expect(r.code()).toBe(403)
    expect(listGrants(getDb(), { subjectId: 'coder' })).toEqual([])
  })

  it('cannot take a grant away, or bring one back', () => {
    const grant = grantForCoder()
    grantsRevokePOST(req({ params: { id: grant.id } }), mockRes().res)
    expect(getGrant(getDb(), grant.id)?.state).toBe('active')
    revokeGrant(getDb(), grant.id, 'a person took it back')
    grantsResumePOST(req({ params: { id: grant.id } }), mockRes().res)
    expect(getGrant(getDb(), grant.id)?.state).toBe('revoked')
  })

  it('can still create a plain agent, with the settings a script needs', async () => {
    const r = mockRes()
    await agentsCreatePOST(
      req({
        body: {
          name: 'Clean Install Smoke',
          sourceId: 'clawboo-native',
          execConfig: {
            primaryProvider: 'ollama',
            primaryModel: 'stub',
            tools: { memory: false, tools: false, tasks: false, teamchat: false },
            maxTurns: 2,
          },
        },
      }),
      r.res,
    )
    expect(r.code()).toBe(201)
  })
})

describe('a person', () => {
  it('can delete a team, and the audit log says who did it', async () => {
    const r = mockRes()
    await teamsDELETE(req({ params: { id: TEAM }, person: ADA }), r.res)
    expect(r.code()).toBe(200)
    expect(getDb().select().from(teams).all()).toEqual([])
    expect(memberOf('coder')).toBeNull()
    const row = listGovernanceAudit(getDb(), { eventType: 'board', limit: 10 })[0]!
    expect(row.teamId).toBe(TEAM)
    expect(JSON.parse(row.summary)).toMatchObject({
      action: 'delete_team',
      name: 'Team',
      actor: { kind: 'person' },
      person: ADA,
    })
  })

  it('leaves nothing in the audit log for a team that was not there', async () => {
    const r = mockRes()
    await teamsDELETE(req({ params: { id: 'nope' }, headers: DASHBOARD }), r.res)
    expect(r.code()).toBe(200)
    expect(listGovernanceAudit(getDb(), { limit: 10 })).toEqual([])
  })

  it('can archive a room, and the audit log says who did it', async () => {
    const room = createRoom(getDb(), { teamId: TEAM, name: 'Launch', memberIds: [] })
    const r = mockRes()
    await teamRoomDELETE(req({ params: { id: TEAM, roomId: room.id }, person: ADA }), r.res)
    expect(r.code()).toBe(200)
    expect(getRoom(getDb(), room.id)?.archivedAt).not.toBeNull()
    const row = listGovernanceAudit(getDb(), { eventType: 'board', limit: 10 })[0]!
    expect(JSON.parse(row.summary)).toMatchObject({
      action: 'archive_room',
      roomId: room.id,
      name: 'Launch',
      actor: { kind: 'person' },
      person: ADA,
    })
  })

  it('takes an agent off the team it is on', () => {
    const r = mockRes()
    teamAgentDELETE(req({ params: { id: TEAM, agentId: 'coder' }, headers: DASHBOARD }), r.res)
    expect(r.code()).toBe(200)
    expect(memberOf('coder')).toBeNull()
  })

  it('gets a 404 for an agent that is on another team, and it stays there', () => {
    otherTeam()
    const r = mockRes()
    teamAgentDELETE(req({ params: { id: OTHER, agentId: 'coder' }, headers: DASHBOARD }), r.res)
    expect(r.code()).toBe(404)
    expect(memberOf('coder')).toBe(TEAM)
  })

  it('gets a 404 for an agent no one has heard of', () => {
    const r = mockRes()
    teamAgentDELETE(req({ params: { id: TEAM, agentId: 'nobody' }, headers: DASHBOARD }), r.res)
    expect(r.code()).toBe(404)
  })

  it('can put an agent on a team, move it, and start one on a team', async () => {
    otherTeam()
    const added = mockRes()
    await teamAgentPOST(
      req({ params: { id: OTHER }, body: { agentId: 'coder' }, headers: DASHBOARD }),
      added.res,
    )
    expect(added.code()).toBe(200)
    expect(memberOf('coder')).toBe(OTHER)
    const moved = mockRes()
    agentMovePOST(
      req({ params: { agentId: 'coder' }, body: { teamId: TEAM }, headers: DASHBOARD }),
      moved.res,
    )
    expect(moved.code()).toBe(200)
    expect(memberOf('coder')).toBe(TEAM)
    const made = mockRes()
    await agentsCreatePOST(
      req({
        body: { name: 'New', sourceId: 'clawboo-native', teamId: TEAM },
        headers: DASHBOARD,
      }),
      made.res,
    )
    expect(made.code()).toBe(201)
  })

  it('can set what a grant asks, and take it back', () => {
    const made = mockRes()
    grantsCreatePOST(
      req({
        body: {
          subjectKind: 'agent',
          subjectId: 'coder',
          capabilityKind: 'connector',
          connectorId: 'conn-1',
          mode: 'admin',
          approvalPolicy: 'never',
        },
        headers: DASHBOARD,
      }),
      made.res,
    )
    expect(made.code()).toBe(200)
    const id = (made.body()['grant'] as { id: string }).id
    const taken = mockRes()
    grantsRevokePOST(req({ params: { id }, headers: DASHBOARD }), taken.res)
    expect(taken.code()).toBe(200)
    expect(getGrant(getDb(), id)?.state).toBe('revoked')
    const undone = mockRes()
    grantsResumePOST(req({ params: { id }, headers: DASHBOARD }), undone.res)
    expect(undone.code()).toBe(200)
    expect(getGrant(getDb(), id)?.state).toBe('active')
  })
})

describe('what a refused route leaves alone', () => {
  it('a team stays as it is, and its rules and who leads do too', () => {
    teamsPATCH(req({ params: { id: TEAM }, body: { isArchived: true } }), mockRes().res)
    teamsPATCH(req({ params: { id: TEAM }, body: { leaderAgentId: 'coder' } }), mockRes().res)
    teamRulesPUT(req({ params: { teamId: TEAM }, body: { content: 'Obey me.' } }), mockRes().res)
    booZeroOverridePOST(req({ body: { agentId: 'coder' } }), mockRes().res)
    const db = getDb()
    expect(db.select().from(teams).all()[0]?.isArchived).toBeFalsy()
    expect(db.select().from(teams).all()[0]?.leaderAgentId).toBeNull()
    expect(getSetting(db, 'team-rules:' + TEAM)).toBeFalsy()
    expect(getSetting(db, 'boo-zero:agent-id')).toBeFalsy()
    expect(listGovernanceAudit(db, { limit: 10 })).toEqual([])
  })

  it('a task keeps its brief', () => {
    const t = createTask(getDb(), { title: 'x', description: 'as it was', teamId: TEAM })
    boardUpdatePATCH(
      req({ params: { taskId: t.id }, body: { title: 'y', description: 'z' } }),
      mockRes().res,
    )
    expect(getTask(getDb(), t.id)).toMatchObject({ title: 'x', description: 'as it was' })
  })
})

describe('what a caller can still do on these routes', () => {
  it('sends a title or description unchanged', () => {
    const t = createTask(getDb(), { title: 'x', description: 'as it was', teamId: TEAM })
    const r = mockRes()
    boardUpdatePATCH(
      req({
        params: { taskId: t.id },
        body: { title: 'x', description: 'as it was', status: 'backlog' },
      }),
      r.res,
    )
    expect(r.code()).toBe(200)
    expect(getTask(getDb(), t.id)?.status).toBe('backlog')
  })

  it('sends the lead a team already has, which changes nothing', () => {
    const r = mockRes()
    teamsPATCH(req({ params: { id: TEAM }, body: { leaderAgentId: null, name: 'Renamed' } }), r.res)
    expect(r.code()).toBe(200)
    expect(listGovernanceAudit(getDb(), { limit: 10 })).toEqual([])
  })

  it('renames a team, which only names it', () => {
    const r = mockRes()
    teamsPATCH(req({ params: { id: TEAM }, body: { name: 'Renamed' } }), r.res)
    expect(r.code()).toBe(200)
  })

  it('sends an archive flag that changes nothing', () => {
    const r = mockRes()
    teamsPATCH(req({ params: { id: TEAM }, body: { isArchived: false } }), r.res)
    expect(r.code()).toBe(200)
  })
})

describe('cancelling a task with work waiting on it', () => {
  function waiting(): { task: string; next: string } {
    const db = getDb()
    const task = createTask(db, { title: 'first', teamId: TEAM, status: 'todo' })
    const next = createTask(db, { title: 'second', teamId: TEAM, status: 'todo' })
    linkDep(db, next.id, task.id)
    return { task: task.id, next: next.id }
  }

  it('a person’s cancel is theirs all the way down, so it stays cancelled', () => {
    const { task, next } = waiting()
    const r = mockRes()
    boardUpdatePATCH(
      req({ params: { taskId: task }, body: { status: 'cancelled' }, headers: DASHBOARD }),
      r.res,
    )
    expect(r.code()).toBe(200)
    expect(getTask(getDb(), next)?.status).toBe('cancelled')
    expect(getTask(getDb(), next)?.personCancelledAt).not.toBeNull()
  })

  it('a caller’s cancel does not read as a person’s', () => {
    const { task, next } = waiting()
    const r = mockRes()
    boardUpdatePATCH(req({ params: { taskId: task }, body: { status: 'cancelled' } }), r.res)
    expect(r.code()).toBe(200)
    expect(getTask(getDb(), next)?.status).toBe('cancelled')
    expect(getTask(getDb(), next)?.personCancelledAt).toBeNull()
  })
})

describe('an answer to a plan from a one-to-one chat', () => {
  it('is that chat’s to send, at once, and no team session hears it', async () => {
    const CHAT = 'agent:bz:codex'
    const db = getDb()
    setSetting(db, planApprovalSettingKey(TEAM), JSON.stringify({ on: true }))
    const made = proposePlan(db, {
      teamId: TEAM,
      agentId: 'bz',
      prompt: 'p',
      steps: [
        { title: 'one', agentId: 'coder', agentName: 'Coder' },
        { title: 'two', agentId: 'coder', agentName: 'Coder' },
      ],
      taskId: null,
      parentTaskId: null,
      turnId: 'chat-turn',
      parallel: true,
      chatSessionKey: CHAT,
    })
    if (made.status !== 'proposed') throw new Error(made.status)
    const told: string[] = []
    const stop = onChatReportUp((key) => told.push(key))

    const r = mockRes()
    await boardQuestionAnswerPOST(
      req({
        params: { questionId: made.question.id },
        body: { answer: { kind: 'suggest_tasks', accepted: false, tasks: [] } },
        headers: DASHBOARD,
      }),
      r.res,
    )
    stop()

    expect(r.code()).toBe(200)
    expect(told).toEqual([CHAT])
    expect(listPendingChatReportUps(db, CHAT)).toHaveLength(1)
    expect(listPendingReportUps(db, TEAM, null)).toEqual([])
  })
})

describe('who did it', () => {
  it('a Reopen records the person, on the event', async () => {
    const id = doneTask()
    await boardReopenPOST(req({ params: { taskId: id }, person: ADA }), mockRes().res)
    expect(eventsOf('status_changed', id).find((e) => e['reason'] === 'reopened')).toMatchObject({
      actor: { kind: 'person' },
      person: ADA,
    })
  })

  it('assigning to a person records the person, on the event', () => {
    const t = createTask(getDb(), { title: 'x', teamId: TEAM })
    boardAssignPersonPOST(req({ params: { taskId: t.id }, person: ADA }), mockRes().res)
    expect(
      eventsOf('status_changed', t.id).find((e) => e['reason'] === 'assigned_person'),
    ).toMatchObject({ actor: { kind: 'person' }, person: ADA })
  })

  it('a question keeps the run that asked, and an answer says who said what', async () => {
    const { taskId, questionId } = asked()
    expect(listTaskQuestions(getDb(), taskId)[0]?.executionId).toBe('exec-1')
    const r = mockRes()
    await boardQuestionAnswerPOST(
      req({
        params: { questionId },
        body: { answer: { text: 'That one' } },
        headers: DASHBOARD,
      }),
      r.res,
    )
    expect(r.code()).toBe(200)
    const onThread = getComments(getDb(), taskId)
    expect(onThread.find((c) => c.kind === 'agent')).toMatchObject({
      authorAgentId: 'coder',
      executionId: 'exec-1',
    })
    expect(onThread.find((c) => c.kind === 'person')?.executionId).toBeNull()
    const actors = eventsOf('comment_added', taskId).map((e) => e['actor'])
    expect(actors).toEqual([AGENT_RUN, { kind: 'person' }])
  })

  it('an agent asking and handing back are the agent and its run, on the event', () => {
    const { taskId } = asked()
    expect(eventsOf('status_changed', taskId).at(-1)).toMatchObject({
      reason: 'question',
      actor: AGENT_RUN,
    })
    const t = createTask(getDb(), { title: 'mine', teamId: TEAM })
    claimTask(getDb(), t.id, 'coder')
    const back = handBackTask(getDb(), t.id, {
      agentId: 'coder',
      need: 'Sign the form.',
      executionId: 'exec-1',
    })
    expect(back.ok).toBe(true)
    expect(eventsOf('status_changed', t.id).at(-1)).toMatchObject({
      reason: 'handed_back',
      actor: AGENT_RUN,
    })
  })

  it('a reply that starts a task again records the person', async () => {
    const db = getDb()
    const t = createTask(db, {
      title: 'stuck',
      teamId: TEAM,
      sourceDelegationId: 'r1:deleg:agent:coder:reflectTo:lead',
    })
    updateStatus(db, t.id, 'blocked')
    await boardCommentPOST(
      req({
        params: { taskId: t.id },
        body: { body: 'Go on', authorType: 'user' },
        person: ADA,
      }),
      mockRes().res,
    )
    expect(eventsOf('status_changed', t.id).find((e) => e['reason'] === 'reply')).toMatchObject({
      actor: { kind: 'person' },
    })
  })

  it('a wake is clawboo acting: its move says why, and names no actor', async () => {
    const { taskId, questionId } = asked()
    await boardQuestionAnswerPOST(
      req({ params: { questionId }, body: { answer: { text: 'That one' } }, person: ADA }),
      mockRes().res,
    )
    const move = eventsOf('status_changed', taskId).find((e) => e['reason'] === 'wake')
    expect(move).toMatchObject({ to: 'todo', wakeReason: 'question_answered' })
    expect(move).not.toHaveProperty('actor')
  })

  describe('the card about agents waking each other', () => {
    const lastAudit = (): Record<string, unknown> =>
      JSON.parse(listGovernanceAudit(getDb(), { limit: 10 })[0]!.summary) as Record<string, unknown>

    it('an answer records the person on the audit feed, and on the job', () => {
      const id = askingCard()
      const r = mockRes()
      boardAgentWakesPOST(
        req({ params: { jobTaskId: id }, body: { decision: 'no' }, person: ADA }),
        r.res,
      )
      expect(r.code()).toBe(200)
      expect(lastAudit()).toMatchObject({
        agentWakes: 'no',
        actor: { kind: 'person' },
        person: ADA,
      })
      expect(JSON.parse(readAgentWakeGate(getDb(), id)?.decidedBy ?? 'null')).toEqual(ADA)
    })

    it('from the dashboard it records the person, with no one named on a local install', () => {
      boardAgentWakesPOST(
        req({ params: { jobTaskId: askingCard() }, body: { decision: 'no' }, headers: DASHBOARD }),
        mockRes().res,
      )
      expect(lastAudit()['actor']).toEqual({ kind: 'person' })
      expect(lastAudit()).not.toHaveProperty('person')
    })

    it('a refused answer leaves the card up, and records nothing', () => {
      const id = askingCard()
      const r = mockRes()
      boardAgentWakesPOST(req({ params: { jobTaskId: id }, body: { decision: 'job' } }), r.res)
      expect(r.code()).toBe(403)
      expect(readAgentWakeGate(getDb(), id)).toMatchObject({ decision: null, cardKind: 'ask' })
      expect(listGovernanceAudit(getDb(), { limit: 10 })).toEqual([])
    })

    it('the team’s always allow records the person, on the audit feed', () => {
      teamAgentWakesPUT(
        req({ params: { teamId: TEAM }, body: { always: true }, person: ADA }),
        mockRes().res,
      )
      expect(readTeamAlwaysAllow(getDb(), TEAM)).toBe(true)
      expect(lastAudit()).toMatchObject({
        agentWakesAlways: true,
        actor: { kind: 'person' },
        person: ADA,
      })
    })

    it('a refused always allow changes nothing, and records nothing', () => {
      const r = mockRes()
      teamAgentWakesPUT(req({ params: { teamId: TEAM }, body: { always: true } }), r.res)
      expect(r.code()).toBe(403)
      expect(readTeamAlwaysAllow(getDb(), TEAM)).toBe(false)
      expect(listGovernanceAudit(getDb(), { limit: 10 })).toEqual([])
    })
  })

  it.each([
    [
      'set_team_rules',
      (who: Who) =>
        teamRulesPUT(
          req({ params: { teamId: TEAM }, body: { content: 'Be brief.' }, ...who }),
          mockRes().res,
        ),
    ],
    [
      'set_user_intro',
      (who: Who) =>
        teamOnboardingPATCH(
          req({ params: { id: TEAM }, body: { userIntroText: 'I am Ada.' }, ...who }),
          mockRes().res,
        ),
    ],
    [
      'set_boo_zero_override',
      (who: Who) => booZeroOverridePOST(req({ body: { agentId: 'coder' }, ...who }), mockRes().res),
    ],
  ])('%s goes on the audit feed with who did it', (action, call) => {
    call({ person: ADA })
    const summary = JSON.parse(listGovernanceAudit(getDb(), { limit: 10 })[0]!.summary) as Record<
      string,
      unknown
    >
    expect(summary).toMatchObject({ action, actor: { kind: 'person' }, person: ADA })
  })

  it('a label change goes on the audit feed with who did it', () => {
    teamLabelsPOST(req({ params: { id: TEAM }, body: { name: 'Bug' }, person: ADA }), mockRes().res)
    const summary = JSON.parse(listGovernanceAudit(getDb(), { limit: 10 })[0]!.summary) as Record<
      string,
      unknown
    >
    expect(summary).toMatchObject({
      action: 'create_label',
      actor: { kind: 'person' },
      person: ADA,
    })
  })
})

describe('pausing and resuming', () => {
  const pauseBody = { kind: 'agent', id: 'coder' }
  const params = { kind: 'agent', id: 'coder' }
  const data = (kind: string): Array<Record<string, unknown>> =>
    listEvents(getDb(), { limit: 100 })
      .filter((e) => e.kind === kind)
      .map((e) => JSON.parse(e.data) as Record<string, unknown>)

  it('records the person on both events, and the proxy’s person on the pause', () => {
    pausesPOST(req({ body: pauseBody, person: ADA }), mockRes().res)
    expect(listPauses(getDb())[0]?.pausedBy).toEqual(ADA)
    pausesDELETE(req({ params, person: ADA }), mockRes().res)
    expect(data('pause_placed')[0]).toMatchObject({ actor: { kind: 'person' }, person: ADA })
    expect(data('pause_lifted')[0]).toMatchObject({ actor: { kind: 'person' }, person: ADA })
  })

  it('records the person from the dashboard, with no one named on a local install', () => {
    pausesPOST(req({ body: pauseBody, headers: DASHBOARD }), mockRes().res)
    pausesDELETE(req({ params, headers: DASHBOARD }), mockRes().res)
    for (const kind of ['pause_placed', 'pause_lifted']) {
      expect(data(kind)[0]?.['actor']).toEqual({ kind: 'person' })
      expect(data(kind)[0]).not.toHaveProperty('person')
    }
  })

  it('a refused pause or resume changes nothing and records nothing', () => {
    pausesPOST(req({ body: pauseBody }), mockRes().res)
    expect(listPauses(getDb())).toEqual([])
    placePause(getDb(), { kind: 'agent', id: 'coder' })
    pausesDELETE(req({ params }), mockRes().res)
    expect(listPauses(getDb())).toHaveLength(1)
    expect(data('pause_placed')).toEqual([])
    expect(data('pause_lifted')).toEqual([])
  })

  describe('from a dashboard on plain http at a network address', () => {
    // What a browser sends there: no fetch metadata, and an Origin naming the address.
    const LAN = { origin: 'http://192.168.1.20:18790', host: '192.168.1.20:18790' }

    it('a person can pause and resume', () => {
      const placed = mockRes()
      pausesPOST(req({ body: pauseBody, headers: LAN }), placed.res)
      expect(placed.code()).toBe(201)
      expect(listPauses(getDb())).toHaveLength(1)
      const lifted = mockRes()
      pausesDELETE(req({ params, headers: LAN }), lifted.res)
      expect(lifted.code()).toBe(200)
      expect(listPauses(getDb())).toEqual([])
      expect(data('pause_lifted')[0]?.['actor']).toEqual({ kind: 'person' })
    })

    it('an Origin that does not match is still refused', () => {
      const r = mockRes()
      pausesPOST(
        req({ body: pauseBody, headers: { ...LAN, origin: 'http://192.168.1.99:18790' } }),
        r.res,
      )
      expect(r.code()).toBe(403)
      expect(listPauses(getDb())).toEqual([])
    })
  })
})

describe('POST /api/board: a request body names no person', () => {
  const NAMES_A_PERSON = {
    requestedBy: { id: 'someone', name: 'Someone', role: 'admin' },
    requested_by: '{"id":"someone"}',
    assigneePerson: { id: 'someone', name: 'Someone', role: 'admin' },
    assigneePersonId: 'someone',
    assignee_person_id: 'someone',
    person: { id: 'someone', name: 'Someone', role: 'admin' },
  }

  it('without the check, nothing on the row names anyone', () => {
    const r = mockRes()
    boardCreatePOST(req({ body: { title: 'x', teamId: TEAM, ...NAMES_A_PERSON } }), r.res)
    expect(r.code()).toBe(200)
    const task = getTask(getDb(), (r.body()['task'] as { id: string }).id)
    expect(task?.requestedBy).toBeNull()
    expect(task?.assigneePersonId).toBeNull()
    expect(task?.assigneePerson).toBeNull()
  })

  it('with the check, the row names the person the check found', () => {
    const r = mockRes()
    boardCreatePOST(
      req({ body: { title: 'x', teamId: TEAM, ...NAMES_A_PERSON }, person: ADA }),
      r.res,
    )
    const task = getTask(getDb(), (r.body()['task'] as { id: string }).id)
    expect(JSON.parse(task?.requestedBy ?? 'null')).toEqual(ADA)
    expect(task?.assigneePersonId).toBeNull()
  })

  it('a task for me is the person the check found, never one the body named', () => {
    const r = mockRes()
    boardCreatePOST(
      req({
        body: { title: 'x', teamId: TEAM, assignToMe: true, ...NAMES_A_PERSON },
        person: ADA,
      }),
      r.res,
    )
    const task = getTask(getDb(), (r.body()['task'] as { id: string }).id)
    expect(task?.assigneePersonId).toBe(ADA.id)
    expect(JSON.parse(task?.requestedBy ?? 'null')).toEqual(ADA)
  })

  it('a task for me is refused without the check, and nothing is written', () => {
    const r = mockRes()
    boardCreatePOST(req({ body: { title: 'x', teamId: TEAM, assignToMe: true } }), r.res)
    expect(r.code()).toBe(403)
    expect(r.body()['error']).toBe('person_only')
  })
})
