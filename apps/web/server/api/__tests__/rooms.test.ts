// The rooms REST surface: list, create, rename, change members, delete (archive).
// Plus the chat routes' room parameter and the stream's room session keys.

import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  agents,
  chatMessages,
  getSetting,
  listRooms,
  setSetting,
  teams,
  type ClawbooDb,
} from '@clawboo/db'
import { buildTeamSessionKey } from '@clawboo/team-orchestration'
import type { Request, Response } from 'express'

import { getDb, resetDb } from '../../lib/db'
import { nativeTeamSessionSettingKey } from '../../lib/teamChat/nativeTeamSession'
import { resetTeamOrchestrators } from '../../lib/teamChat/teamOrchestrator'
import { teamRoomDELETE, teamRoomPATCH, teamRoomsGET, teamRoomsPOST } from '../rooms'
import { resolveTeamSessionKeys } from '../teamChatStream'
import { teamChatIngestPOST, teamsDELETE } from '../teams'

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

function req(params: Record<string, string>, body?: unknown): Request {
  return { params, body, query: {}, headers: {} } as unknown as Request
}

interface RoomBody {
  room: { id: string; name: string; memberIds: string[]; teamId: string; pinnedAt: number | null }
}

describe('rooms REST', () => {
  let home: string
  let prevHome: string | undefined
  let db: ClawbooDb

  beforeEach(async () => {
    home = await mkdtemp(path.join(os.tmpdir(), 'clawboo-rooms-rest-'))
    await mkdir(path.join(home, '.clawboo'), { recursive: true })
    prevHome = process.env['HOME']
    process.env['HOME'] = home
    process.env['CLAWBOO_HOME'] = path.join(home, '.clawboo')
    db = getDb()
    const now = Date.now()
    for (const id of ['T', 'OTHER']) {
      db.insert(teams)
        .values({ id, name: id, icon: 'T', color: '#e94560', createdAt: now, updatedAt: now })
        .run()
    }
    for (const [id, teamId] of [
      ['a1', 'T'],
      ['a2', 'T'],
      ['a3', 'T'],
      ['x1', 'OTHER'],
    ] as const) {
      db.insert(agents)
        .values({ id, name: id, gatewayId: id, teamId, createdAt: now, updatedAt: now })
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

  function create(body: unknown, teamId = 'T'): { status: number; body: unknown } {
    const r = fakeRes()
    teamRoomsPOST(req({ id: teamId }, body), r.res)
    return { status: r.status(), body: r.body() }
  }

  it('creates a room with a subset of members and lists it', () => {
    const made = create({ name: '  Design  review ', memberIds: ['a1', 'a2', 'a2'] })
    expect(made.status).toBe(201)
    const room = (made.body as RoomBody).room
    expect(room).toMatchObject({ name: 'Design review', memberIds: ['a1', 'a2'], teamId: 'T' })

    const list = fakeRes()
    teamRoomsGET(req({ id: 'T' }), list.res)
    expect((list.body() as { rooms: unknown[] }).rooms).toHaveLength(1)
    const other = fakeRes()
    teamRoomsGET(req({ id: 'OTHER' }), other.res)
    expect((other.body() as { rooms: unknown[] }).rooms).toHaveLength(0)
  })

  it('refuses members from another team, unknown agents, no members and no name', () => {
    expect(create({ name: 'R', memberIds: ['a1', 'x1'] }).status).toBe(400)
    expect(create({ name: 'R', memberIds: ['ghost'] }).status).toBe(400)
    expect(create({ name: 'R', memberIds: [] }).status).toBe(400)
    expect(create({ name: '   ', memberIds: ['a1'] }).status).toBe(400)
    expect(create({ name: 'R', memberIds: 'a1' }).status).toBe(400)
    expect(create({ name: 'R', memberIds: ['a1'] }, 'NOPE').status).toBe(404)
    expect(listRooms(db, 'T')).toHaveLength(0)
  })

  it('renames and replaces members, validating them against the team', () => {
    const room = (create({ name: 'R', memberIds: ['a1'] }).body as RoomBody).room
    const renamed = fakeRes()
    teamRoomPATCH(req({ id: 'T', roomId: room.id }, { name: 'Launch' }), renamed.res)
    expect((renamed.body() as RoomBody).room.name).toBe('Launch')

    const members = fakeRes()
    teamRoomPATCH(req({ id: 'T', roomId: room.id }, { memberIds: ['a2', 'a3'] }), members.res)
    expect((members.body() as RoomBody).room.memberIds).toEqual(['a2', 'a3'])

    const bad = fakeRes()
    teamRoomPATCH(req({ id: 'T', roomId: room.id }, { memberIds: ['x1'] }), bad.res)
    expect(bad.status()).toBe(400)

    const wrongTeam = fakeRes()
    teamRoomPATCH(req({ id: 'OTHER', roomId: room.id }, { name: 'X' }), wrongTeam.res)
    expect(wrongTeam.status()).toBe(404)
  })

  it('pins and unpins a room, and refuses a pinned value that is not a boolean', () => {
    const room = (create({ name: 'R', memberIds: ['a1'] }).body as RoomBody).room
    expect(room.pinnedAt).toBeNull()

    const pinned = fakeRes()
    teamRoomPATCH(req({ id: 'T', roomId: room.id }, { pinned: true }), pinned.res)
    expect(typeof (pinned.body() as RoomBody).room.pinnedAt).toBe('number')

    const unpinned = fakeRes()
    teamRoomPATCH(req({ id: 'T', roomId: room.id }, { pinned: false }), unpinned.res)
    expect((unpinned.body() as RoomBody).room.pinnedAt).toBeNull()

    const bad = fakeRes()
    teamRoomPATCH(req({ id: 'T', roomId: room.id }, { pinned: 'yes' }), bad.res)
    expect(bad.status()).toBe(400)
  })

  it('delete archives: the room leaves the list, its transcript stays, its resume pointers go', () => {
    const room = (create({ name: 'R', memberIds: ['a1', 'a2'] }).body as RoomBody).room
    const roomKey = buildTeamSessionKey('a1', 'T', room.id)
    db.insert(chatMessages)
      .values({ sessionKey: roomKey, gatewayUrl: '', entryId: 'e1', timestampMs: 1, data: '{}' })
      .run()
    setSetting(db, nativeTeamSessionSettingKey('a1', 'T', room.id), 'native-session-1')
    setSetting(db, nativeTeamSessionSettingKey('a1', 'T'), 'team-session-1')

    const del = fakeRes()
    teamRoomDELETE(req({ id: 'T', roomId: room.id }), del.res)
    expect(del.status()).toBe(200)
    expect(listRooms(db, 'T')).toHaveLength(0)
    expect(listRooms(db, 'T', { includeArchived: true })).toHaveLength(1)
    expect(
      db
        .select()
        .from(chatMessages)
        .all()
        .map((r) => r.sessionKey),
    ).toEqual([roomKey])
    expect(getSetting(db, nativeTeamSessionSettingKey('a1', 'T', room.id))).toBeNull()
    // The team's own group chat pointer is not touched.
    expect(getSetting(db, nativeTeamSessionSettingKey('a1', 'T'))).toBe('team-session-1')

    const again = fakeRes()
    teamRoomDELETE(req({ id: 'T', roomId: room.id }), again.res)
    expect(again.status()).toBe(404)
  })

  it('the chat ingest 404s a room that is not one of the team’s, or was deleted', () => {
    const room = (create({ name: 'R', memberIds: ['a1'] }).body as RoomBody).room
    const unknown = fakeRes()
    teamChatIngestPOST(req({ id: 'OTHER' }, { message: 'hi', roomId: room.id }), unknown.res)
    expect(unknown.status()).toBe(404)
    teamRoomDELETE(req({ id: 'T', roomId: room.id }), fakeRes().res)
    const archived = fakeRes()
    teamChatIngestPOST(req({ id: 'T' }, { message: 'hi', roomId: room.id }), archived.res)
    expect(archived.status()).toBe(404)
  })

  it("the stream tails the room's member keys, plain team keys for the group chat", () => {
    const room = (create({ name: 'R', memberIds: ['a1', 'a3'] }).body as RoomBody).room
    expect(resolveTeamSessionKeys(db, 'T', room.id).sort()).toEqual(
      [buildTeamSessionKey('a1', 'T', room.id), buildTeamSessionKey('a3', 'T', room.id)].sort(),
    )
    expect(resolveTeamSessionKeys(db, 'T').sort()).toEqual(
      ['a1', 'a2', 'a3'].map((id) => buildTeamSessionKey(id, 'T')).sort(),
    )
  })

  it('a team delete takes its rooms and their resume pointers with it', () => {
    const room = (create({ name: 'R', memberIds: ['a1'] }).body as RoomBody).room
    setSetting(db, nativeTeamSessionSettingKey('a1', 'T', room.id), 'native-session-1')
    const del = fakeRes()
    teamsDELETE(req({ id: 'T' }), del.res)
    expect(del.status()).toBe(200)
    expect(listRooms(db, 'T', { includeArchived: true })).toHaveLength(0)
    expect(getSetting(db, nativeTeamSessionSettingKey('a1', 'T', room.id))).toBeNull()
  })
})
