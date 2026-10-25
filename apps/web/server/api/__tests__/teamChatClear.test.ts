// Clearing a team's General chat: its messages are set aside (re-keyed, never
// deleted), the agents' memory of the conversation is dropped, rooms keep their
// chats, and the clear time reaches the client on GET /api/teams.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { eq } from 'drizzle-orm'

import { agents, chatMessages, getSetting, setSetting, teams, type ClawbooDb } from '@clawboo/db'
import { buildTeamSessionKey } from '@clawboo/team-orchestration'
import type { Request, Response } from 'express'

import { getDb, resetDb } from '../../lib/db'
import { nativeTeamSessionSettingKey } from '../../lib/teamChat/nativeTeamSession'
import { resetTeamOrchestrators } from '../../lib/teamChat/teamOrchestrator'
import { chatClearedSettingKey } from '../../lib/teamChat/chatCleared'
import { teamRoomsGET, teamRoomsPOST } from '../rooms'
import { teamChatClearPOST, teamsGET } from '../teams'

function fakeRes(): { res: Response; body: () => unknown; status: () => number } {
  let status = 200
  let body: unknown
  const res = {
    status(c: number) {
      status = c
      return this
    },
    json(b: unknown) {
      body = b
      return this
    },
  } as unknown as Response
  return { res, body: () => body, status: () => status }
}

function req(params: Record<string, string>, body: unknown = {}): Request {
  return { params, body, query: {}, headers: {} } as unknown as Request
}

describe('POST /api/teams/:id/chat/clear', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-chat-clear-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = getDb()
    const now = Date.now()
    db.insert(teams)
      .values({ id: 'T', name: 'T', icon: 'T', color: '#e94560', createdAt: now, updatedAt: now })
      .run()
    for (const id of ['a1', 'a2']) {
      db.insert(agents)
        .values({ id, name: id, gatewayId: id, teamId: 'T', createdAt: now, updatedAt: now })
        .run()
    }
  })

  afterEach(async () => {
    resetTeamOrchestrators()
    resetDb()
    if (prevHome === undefined) delete process.env['HOME']
    else process.env['HOME'] = prevHome
    delete process.env['CLAWBOO_HOME']
    await rm(home, { recursive: true, force: true }).catch(() => {})
  })

  function message(sessionKey: string, entryId: string): void {
    db.insert(chatMessages)
      .values({ sessionKey, gatewayUrl: '', entryId, timestampMs: 1, data: '{}' })
      .run()
  }

  it('sets the General chat aside, drops resume pointers, and leaves rooms alone', () => {
    const general1 = buildTeamSessionKey('a1', 'T')
    const general2 = buildTeamSessionKey('a2', 'T')
    const roomKey = buildTeamSessionKey('a1', 'T', 'R1')
    message(general1, 'g1')
    message(general2, 'g2')
    message(roomKey, 'r1')
    setSetting(db, nativeTeamSessionSettingKey('a1', 'T'), 'session-general')
    setSetting(db, nativeTeamSessionSettingKey('a1', 'T', 'R1'), 'session-room')

    const r = fakeRes()
    teamChatClearPOST(req({ id: 'T' }), r.res)
    expect(r.status()).toBe(200)
    const body = r.body() as { ok: boolean; clearedAt: number; cleared: number }
    expect(body).toMatchObject({ ok: true, cleared: 2 })

    // Nothing left under the live General keys; the rows are kept, re-keyed.
    expect(
      db.select().from(chatMessages).where(eq(chatMessages.sessionKey, general1)).all(),
    ).toEqual([])
    const setAside = db
      .select({ key: chatMessages.sessionKey, entryId: chatMessages.entryId })
      .from(chatMessages)
      .all()
      .filter((row) => row.key.includes('#cleared:'))
    expect(setAside.map((row) => row.key).sort()).toEqual(
      [`${general1}#cleared:${body.clearedAt}`, `${general2}#cleared:${body.clearedAt}`].sort(),
    )
    expect(setAside.every((row) => row.entryId.endsWith(`#cleared:${body.clearedAt}`))).toBe(true)

    // The room's chat and memory are untouched.
    expect(
      db.select().from(chatMessages).where(eq(chatMessages.sessionKey, roomKey)).all(),
    ).toHaveLength(1)
    expect(getSetting(db, nativeTeamSessionSettingKey('a1', 'T', 'R1'))).toBe('session-room')
    // The General chat's memory is gone.
    expect(getSetting(db, nativeTeamSessionSettingKey('a1', 'T'))).toBe('')
    expect(getSetting(db, chatClearedSettingKey('T'))).toBe(String(body.clearedAt))

    const list = fakeRes()
    teamsGET({ query: {} } as unknown as Request, list.res)
    const team = (list.body() as { teams: Array<{ id: string; chatClearedAt: number | null }> })
      .teams[0]
    expect(team).toMatchObject({ id: 'T', chatClearedAt: body.clearedAt })
  })

  it("clears one room's chat and leaves General alone", () => {
    const made = fakeRes()
    teamRoomsPOST(req({ id: 'T' }, { name: 'Design', memberIds: ['a1'] }), made.res)
    const roomId = (made.body() as { room: { id: string } }).room.id
    const general = buildTeamSessionKey('a1', 'T')
    const roomKey = buildTeamSessionKey('a1', 'T', roomId)
    message(general, 'g1')
    message(roomKey, 'r1')
    setSetting(db, nativeTeamSessionSettingKey('a1', 'T'), 'session-general')
    setSetting(db, nativeTeamSessionSettingKey('a1', 'T', roomId), 'session-room')

    const r = fakeRes()
    teamChatClearPOST(req({ id: 'T' }, { roomId }), r.res)
    expect(r.status()).toBe(200)
    const { clearedAt } = r.body() as { clearedAt: number }

    expect(
      db.select().from(chatMessages).where(eq(chatMessages.sessionKey, roomKey)).all(),
    ).toEqual([])
    expect(
      db.select().from(chatMessages).where(eq(chatMessages.sessionKey, general)).all(),
    ).toHaveLength(1)
    expect(getSetting(db, nativeTeamSessionSettingKey('a1', 'T', roomId))).toBe('')
    expect(getSetting(db, nativeTeamSessionSettingKey('a1', 'T'))).toBe('session-general')
    expect(getSetting(db, chatClearedSettingKey('T'))).toBeNull()

    const rooms = fakeRes()
    teamRoomsGET(req({ id: 'T' }), rooms.res)
    expect(
      (rooms.body() as { rooms: Array<{ chatClearedAt: number | null }> }).rooms[0],
    ).toMatchObject({
      chatClearedAt: clearedAt,
    })
  })

  it('404s an unknown room', () => {
    const r = fakeRes()
    teamChatClearPOST(req({ id: 'T' }, { roomId: 'NOPE' }), r.res)
    expect(r.status()).toBe(404)
  })

  it('404s an unknown team', () => {
    const r = fakeRes()
    teamChatClearPOST(req({ id: 'NOPE' }), r.res)
    expect(r.status()).toBe(404)
  })
})
