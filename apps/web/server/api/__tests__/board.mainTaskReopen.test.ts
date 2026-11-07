// Reopening a request with no engine loaded, through the real route and the real team
// orchestrator. The route tests beside this one record the engine, so they cannot see
// what building an engine does before the person's words get there: its first resume
// reads the request. Only the run primitive is faked, so nothing starts.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import {
  agents,
  chatMessages,
  closeMainTask,
  createHandOffUnderRequest,
  getComments,
  getTask,
  listPendingChatReportUps,
  listPendingReportUps,
  recordReportUp,
  settleReportUps,
  teams,
  updateStatus,
} from '@clawboo/db'
import { REFLECT_WINDOW_MS, type TurnOrigin } from '@clawboo/team-orchestration'
import type { Request, Response } from 'express'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const delivered: Array<{ agentId: string; task: string; origin: TurnOrigin }> = []
vi.mock('../../lib/teamChat/serverDeliver', () => ({
  createServerDeliver:
    () => async (_sk: string, agentId: string, task: string, origin: TurnOrigin) => {
      delivered.push({ agentId, task, origin })
    },
}))

const { getDb, getDbPath, resetDb } = await import('../../lib/db')
const { resetTeamOrchestrators } = await import('../../lib/teamChat/teamOrchestrator')
const { boardReopenPOST } = await import('../boardPerson')

const TEAM = 'T'
const LEAD = 'L'
const DASHBOARD_HEADERS = { 'sec-fetch-site': 'same-origin', 'sec-fetch-mode': 'cors' }

function mockRes(): {
  res: Response
  body: () => { ok: boolean; delivery?: { status: string; agentId: string | null } }
} {
  let payload: unknown
  const res = {
    status() {
      return this
    },
    json(b: unknown) {
      payload = b
      return this
    },
  } as unknown as Response
  return { res, body: () => payload as never }
}
const reopen = (taskId: string, body: Record<string, unknown>): Request =>
  ({
    params: { taskId },
    query: {},
    body,
    headers: DASHBOARD_HEADERS,
    app: { locals: {} },
    get: () => undefined,
  }) as unknown as Request

const settle = async (): Promise<void> => {
  for (let i = 0; i < 8; i++) await new Promise((r) => setImmediate(r))
}

describe('reopening a request after its engine has gone', () => {
  let home: string
  let prevHome: string | undefined
  let prevClawbooHome: string | undefined

  beforeEach(async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'setInterval'] })
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-main-reopen-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    prevClawbooHome = process.env['CLAWBOO_HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    expect(getDbPath().startsWith(home)).toBe(true)
    delivered.length = 0
    const db = getDb()
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
    // Coding-runtime members, so no native Boo Zero is created to take the lead.
    db.insert(agents)
      .values({
        id: LEAD,
        name: 'Lead',
        gatewayId: LEAD,
        runtime: 'codex',
        teamId: TEAM,
        createdAt: now,
        updatedAt: now,
      })
      .run()
  })

  afterEach(async () => {
    resetTeamOrchestrators()
    await settle()
    resetDb()
    vi.useRealTimers()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    if (prevClawbooHome === undefined) delete process.env['CLAWBOO_HOME']
    else process.env['CLAWBOO_HOME'] = prevClawbooHome
    await rm(home, { recursive: true, force: true })
  })

  /** A request that closed after its lead answered a row filed on the main task. */
  function closedAfterAnEarlierWord(): string {
    const db = getDb()
    const made = createHandOffUnderRequest(
      db,
      { title: 'Build it', description: 'Build it', leadAgentId: LEAD, key: 'main:T:d1' },
      { title: 'one', teamId: TEAM, sourceDelegationId: 'd1:deleg:agent:W:reflectTo:L' },
    )
    if (!made.ok) throw new Error(made.reason)
    const mainId = made.task.parentTaskId as string
    updateStatus(db, made.task.id, 'in_progress')
    updateStatus(db, made.task.id, 'done')
    const row = recordReportUp(db, {
      teamId: TEAM,
      roomId: null,
      recipientAgentId: LEAD,
      taskId: mainId,
      payload: JSON.stringify({ toAgentId: LEAD, by: 'x', summary: 'earlier', taskId: mainId }),
    })
    settleReportUps(db, [row], 'delivered')
    closeMainTask(db, mainId, 'done')
    return mainId
  }

  it('stays open, and the person’s words reach its lead', async () => {
    const mainId = closedAfterAnEarlierWord()
    const r = mockRes()
    await boardReopenPOST(reopen(mainId, { comment: 'Please try again' }), r.res)
    await settle()
    expect(getTask(getDb(), mainId)?.status).toBe('in_progress')
    expect(r.body().delivery).toEqual({ status: 'woke-agent', agentId: LEAD })
    expect(getComments(getDb(), mainId).map((c) => c.body)).toContain('Please try again')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    await settle()
    expect(delivered).toHaveLength(1)
    expect(delivered[0]!.agentId).toBe(LEAD)
    expect(delivered[0]!.task).toContain('Please try again')
    expect(delivered[0]!.origin).toMatchObject({ kind: 'system', mainTaskId: mainId })
    expect(getTask(getDb(), mainId)?.status).toBe('in_progress')
  })

  it('a request from a one-to-one chat is answered there, not in a team session', async () => {
    const CHAT = 'agent:lead:codex'
    const db = getDb()
    const made = createHandOffUnderRequest(
      db,
      {
        title: 'Build it',
        description: 'Build it',
        leadAgentId: LEAD,
        key: 'main:T:chat-message',
        chatSessionKey: CHAT,
      },
      {
        title: 'one',
        teamId: TEAM,
        sourceDelegationId: 'd1:deleg:agent:W:reflectTo:L',
        chatSessionKey: CHAT,
      },
    )
    if (!made.ok) throw new Error(made.reason)
    const mainId = made.task.parentTaskId as string
    updateStatus(db, made.task.id, 'in_progress')
    updateStatus(db, made.task.id, 'done')
    closeMainTask(db, mainId, 'done')

    const r = mockRes()
    await boardReopenPOST(reopen(mainId, { comment: 'Please try again' }), r.res)
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    await settle()

    expect(getTask(db, mainId)?.status).toBe('in_progress')
    const kept = listPendingChatReportUps(db, CHAT).map(
      (row) => JSON.parse(row.payload) as { outcome: string; summary: string; taskId: string },
    )
    expect(kept).toEqual([
      expect.objectContaining({
        outcome: 'person_comment',
        summary: 'Please try again',
        taskId: mainId,
      }),
    ])
    expect(listPendingReportUps(db, TEAM, null)).toEqual([])
    expect(delivered).toEqual([])
    const chat = db.select().from(chatMessages).all()
    expect(chat.map((m) => m.sessionKey)).toEqual([CHAT])
    expect(chat[0]!.data).toContain('A person reopened')
  })

  it('tells its lead with no words too, and says so in the chat', async () => {
    const mainId = closedAfterAnEarlierWord()
    const first = mockRes()
    await boardReopenPOST(reopen(mainId, {}), first.res)
    await settle()
    expect(first.body().delivery?.status).toBe('woke-agent')
    expect(getTask(getDb(), mainId)?.status).toBe('in_progress')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    await settle()
    expect(delivered.map((d) => d.task).join()).toContain('reopened')
    const chat = getDb()
      .select()
      .from(chatMessages)
      .all()
      .map((m) => m.data)
      .join()
    expect(chat).toContain('A person reopened')
  })

  it('holds for a second Reopen after the engine goes again', async () => {
    const mainId = closedAfterAnEarlierWord()
    const db = getDb()
    await boardReopenPOST(reopen(mainId, { comment: 'First' }), mockRes().res)
    await settle()
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    await settle()
    // Its run finished and the request closed again, and then the engine was evicted.
    settleReportUps(
      db,
      listPendingReportUps(db, TEAM, null).map((r) => r.id),
      'delivered',
    )
    closeMainTask(db, mainId, 'done')
    resetTeamOrchestrators()
    await settle()

    const r = mockRes()
    await boardReopenPOST(reopen(mainId, { comment: 'Second' }), r.res)
    await settle()
    expect(getTask(db, mainId)?.status).toBe('in_progress')
    expect(r.body().delivery?.status).toBe('woke-agent')
    await vi.advanceTimersByTimeAsync(REFLECT_WINDOW_MS)
    await settle()
    expect(delivered.at(-1)!.task).toContain('Second')
  })
})
