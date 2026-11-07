// A result headed for a one-to-one chat has its own scope in the report-up outbox.
// The team's engine must never see such a row: it would send the update into the
// recipient's team session, and the chat that asked would hear nothing. The chat's
// own readers see only its rows, and the rows outlive the process that wrote them.

import { mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agents,
  createTask,
  getTask,
  holdReportUps,
  listChatHandOffTasks,
  listChatsWithPendingReportUps,
  listHeldChatReportUps,
  listHeldReportUps,
  listPendingChatReportUps,
  listPendingReportUps,
  listRoomsWithPendingReportUps,
  NO_TEAM_REPORT_UP,
  reapReportUps,
  recordReportUp,
  settleReportUps,
  teams,
  type ClawbooDb,
} from '@clawboo/db'

import { getDb, getDbPath, resetDb } from '../../db'
import { createChatReportUps } from '../chatReportUpOutbox'

const TEAM = 'T'
const CHAT = 'agent:bz:native'

describe('the report-up outbox: a one-to-one chat as its own scope', () => {
  let home: string
  const prev: Record<string, string | undefined> = {}
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-chat-outbox-'))
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
        name: 'Growth',
        icon: 'x',
        color: '#000',
        createdAt: now,
        updatedAt: now,
      })
      .run()
    db.insert(agents)
      .values({
        id: 'w',
        name: 'Worker',
        gatewayId: 'w',
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
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    await rm(home, { recursive: true, force: true })
  })

  const row = (over: { chatSessionKey?: string | null; held?: boolean } = {}): string =>
    recordReportUp(db, {
      teamId: TEAM,
      roomId: null,
      recipientAgentId: 'bz',
      taskId: null,
      payload: '{}',
      ...over,
    })

  it("keeps a chat's rows out of every team and room reader", () => {
    const chatRow = row({ chatSessionKey: CHAT })
    const heldChatRow = row({ chatSessionKey: CHAT, held: true })
    const teamRow = row()

    expect(listPendingReportUps(db, TEAM, null).map((r) => r.id)).toEqual([teamRow])
    expect(listHeldReportUps(db, TEAM, null)).toEqual([])
    expect(listRoomsWithPendingReportUps(db)).toEqual([{ teamId: TEAM, roomId: null }])

    settleReportUps(db, [teamRow], 'delivered')
    // Only the chat's own rows are left, and they wake no team's engine.
    expect(listRoomsWithPendingReportUps(db)).toEqual([])
    expect(listPendingChatReportUps(db, CHAT).map((r) => r.id)).toEqual([chatRow])
    expect(listHeldChatReportUps(db, CHAT).map((r) => r.id)).toEqual([heldChatRow])
  })

  it('names each chat holding rows to send, and not one whose rows are held or settled', () => {
    const a = row({ chatSessionKey: CHAT })
    row({ chatSessionKey: 'agent:other:native', held: true })
    expect(listChatsWithPendingReportUps(db)).toEqual([CHAT])

    holdReportUps(db, [a])
    expect(listChatsWithPendingReportUps(db)).toEqual([])
    expect(listPendingChatReportUps(db, CHAT)).toEqual([])
    expect(listHeldChatReportUps(db, CHAT).map((r) => r.id)).toEqual([a])

    settleReportUps(db, [a], 'delivered')
    expect(listHeldChatReportUps(db, CHAT)).toEqual([])
  })

  it('reaps a chat row whose team is gone, as it does a team row', () => {
    recordReportUp(db, {
      teamId: 'gone',
      roomId: null,
      recipientAgentId: 'bz',
      taskId: null,
      payload: '{}',
      chatSessionKey: CHAT,
    })
    expect(reapReportUps(db)).toBe(1)
    expect(listPendingChatReportUps(db, CHAT)).toEqual([])
  })

  it('keeps a chat row about no team until it is heard, past the orphan rule', () => {
    recordReportUp(db, {
      teamId: NO_TEAM_REPORT_UP,
      roomId: null,
      recipientAgentId: 'bz',
      taskId: null,
      payload: '{}',
      chatSessionKey: CHAT,
      held: true,
    })
    expect(reapReportUps(db)).toBe(0)
    expect(listHeldChatReportUps(db, CHAT)).toHaveLength(1)
  })

  it('a task remembers the chat it was handed off from, and the chat lists its tasks', () => {
    const first = createTask(db, { title: 'one', teamId: TEAM, chatSessionKey: CHAT })
    const second = createTask(db, { title: 'two', teamId: TEAM, chatSessionKey: CHAT })
    createTask(db, { title: 'plain', teamId: TEAM })
    createTask(db, { title: 'elsewhere', teamId: TEAM, chatSessionKey: 'agent:other:native' })

    expect(getTask(db, first.id)?.chatSessionKey).toBe(CHAT)
    expect(listChatHandOffTasks(db, CHAT).map((t) => t.id)).toEqual([first.id, second.id])
  })

  describe('the writer the team engine calls', () => {
    const recorded: string[] = []
    const take = (
      item: Parameters<ReturnType<typeof createChatReportUps>['take']>[0],
      held = false,
    ) => createChatReportUps(db, TEAM, { onRecorded: (k) => recorded.push(k) }).take(item, { held })

    beforeEach(() => {
      recorded.length = 0
    })

    it('leaves a report-up on a task with no chat to the team', () => {
      const task = createTask(db, { title: 'plain', teamId: TEAM })
      expect(take({ toAgentId: 'bz', by: 'Worker', summary: 'done', taskId: task.id })).toBe(false)
      expect(take({ toAgentId: 'bz', by: 'Worker', summary: 'done' })).toBe(false)
      expect(recorded).toEqual([])
    })

    it('keeps a report-up on a task from a chat for that chat, and says so', () => {
      const task = createTask(db, { title: 'one', teamId: TEAM, chatSessionKey: CHAT })
      expect(take({ toAgentId: 'bz', by: 'Worker', summary: 'shipped', taskId: task.id })).toBe(
        true,
      )
      expect(listPendingChatReportUps(db, CHAT)).toHaveLength(1)
      expect(listPendingReportUps(db, TEAM, null)).toHaveLength(0)
      expect(recorded).toEqual([CHAT])
    })

    it('keeps one a person stopped as held: it wakes no one', () => {
      const task = createTask(db, { title: 'one', teamId: TEAM, chatSessionKey: CHAT })
      expect(take({ toAgentId: 'bz', by: 'Worker', summary: 'late', taskId: task.id }, true)).toBe(
        true,
      )
      expect(listPendingChatReportUps(db, CHAT)).toEqual([])
      expect(listHeldChatReportUps(db, CHAT)).toHaveLength(1)
      expect(recorded).toEqual([])
    })

    it('takes a refusal that has no task yet, by the chat it names', () => {
      expect(
        take({
          toAgentId: 'bz',
          by: 'Worker',
          summary: 'could not start',
          outcome: 'not_started',
          chatSessionKey: CHAT,
        }),
      ).toBe(true)
      expect(listPendingChatReportUps(db, CHAT)).toHaveLength(1)
    })
  })
})
