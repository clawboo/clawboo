import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { agents, roomMembers, teams } from '../../schema'
import {
  createSubtask,
  createTask,
  getReadyTasks,
  listRoomsWithFireableDelegations,
  listTasks,
  listTeamsWithFireableDelegations,
} from '../repository'
import {
  activeRoomMemberIds,
  addRoomMembers,
  archiveRoom,
  createRoom,
  getActiveRoom,
  invalidRoomMembers,
  listRooms,
  normalizeRoomName,
  renameRoom,
  setRoomMembers,
} from '../rooms'

let dir: string
let db: ClawbooDb

function seedTeam(id: string): void {
  const now = Date.now()
  db.insert(teams)
    .values({ id, name: id, icon: 'x', color: '#000', createdAt: now, updatedAt: now })
    .run()
}

function seedAgent(id: string, teamId: string | null, archived = false): void {
  const now = Date.now()
  db.insert(agents)
    .values({
      id,
      name: id,
      gatewayId: id,
      status: 'idle',
      teamId,
      archivedAt: archived ? now : null,
      createdAt: now,
      updatedAt: now,
    })
    .run()
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-rooms-'))
  db = createDb(path.join(dir, 'test.db'))
  seedTeam('T')
  seedTeam('OTHER')
  seedAgent('a1', 'T')
  seedAgent('a2', 'T')
  seedAgent('a3', 'T')
  seedAgent('gone', 'T', true)
  seedAgent('x1', 'OTHER')
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('rooms', () => {
  it('creates, lists and reads a room with its members in join order', () => {
    const room = createRoom(db, { teamId: 'T', name: 'Design', memberIds: ['a2', 'a1', 'a2'] })
    expect(room.memberIds).toEqual(['a2', 'a1'])
    expect(listRooms(db, 'T').map((r) => [r.name, r.memberIds])).toEqual([['Design', ['a2', 'a1']]])
    expect(listRooms(db, 'OTHER')).toEqual([])
    expect(getActiveRoom(db, 'OTHER', room.id)).toBeNull()
  })

  it('rejects members that are not active agents of the team', () => {
    expect(invalidRoomMembers(db, 'T', ['a1', 'a2'])).toEqual([])
    expect(invalidRoomMembers(db, 'T', ['a1', 'x1', 'gone', 'nope']).sort()).toEqual(
      ['gone', 'nope', 'x1'].sort(),
    )
  })

  it('renames and replaces members, keeping the join order of members that stay', () => {
    const room = createRoom(db, { teamId: 'T', name: 'A', memberIds: ['a1', 'a2'] })
    expect(renameRoom(db, room.id, 'B')?.name).toBe('B')
    expect(setRoomMembers(db, room.id, ['a3', 'a2'])?.memberIds).toEqual(['a2', 'a3'])
  })

  it('adds members without dropping any, so two adds from the same roster both land', () => {
    const room = createRoom(db, { teamId: 'T', name: 'A', memberIds: ['a1'] })
    // Two callers that both read the roster as [a1] before either wrote.
    addRoomMembers(db, room.id, ['a2'])
    expect(addRoomMembers(db, room.id, ['a3'])?.memberIds).toEqual(['a1', 'a2', 'a3'])
    // Adding a current member is a no-op that keeps its join order.
    expect(addRoomMembers(db, room.id, ['a1', 'a2'])?.memberIds).toEqual(['a1', 'a2', 'a3'])
  })

  it('archives instead of deleting', () => {
    const room = createRoom(db, { teamId: 'T', name: 'A', memberIds: ['a1'] })
    archiveRoom(db, room.id)
    expect(listRooms(db, 'T')).toEqual([])
    expect(listRooms(db, 'T', { includeArchived: true })).toHaveLength(1)
    expect(getActiveRoom(db, 'T', room.id)).toBeNull()
    expect(activeRoomMemberIds(db, 'T', room.id)).toEqual([])
  })

  it('the live roster drops members that left the team or were archived', () => {
    const room = createRoom(db, { teamId: 'T', name: 'A', memberIds: ['a1', 'a2'] })
    db.update(agents).set({ teamId: 'OTHER' }).where(eq(agents.id, 'a2')).run()
    expect(activeRoomMemberIds(db, 'T', room.id)).toEqual(['a1'])
  })

  it('membership goes with a deleted agent row and with a deleted team', () => {
    const room = createRoom(db, { teamId: 'T', name: 'A', memberIds: ['a1', 'a2'] })
    db.delete(agents).where(eq(agents.id, 'a1')).run()
    expect(listRooms(db, 'T')[0]?.memberIds).toEqual(['a2'])
    db.update(agents).set({ teamId: null }).where(eq(agents.teamId, 'T')).run()
    db.delete(teams).where(eq(teams.id, 'T')).run()
    expect(listRooms(db, 'T', { includeArchived: true })).toEqual([])
    expect(db.select().from(roomMembers).where(eq(roomMembers.roomId, room.id)).all()).toEqual([])
  })

  it('normalizes names', () => {
    expect(normalizeRoomName('  Launch   prep ')).toBe('Launch prep')
    expect(normalizeRoomName('   ')).toBeNull()
    expect(normalizeRoomName(42)).toBeNull()
    expect(normalizeRoomName('x'.repeat(200))).toHaveLength(80)
  })
})

describe('board tasks and rooms', () => {
  it('filters by room: undefined is every room, null is the default room', () => {
    const room = createRoom(db, { teamId: 'T', name: 'A', memberIds: ['a1'] })
    const inDefault = createTask(db, { title: 'default', teamId: 'T' })
    const inRoom = createTask(db, { title: 'room', teamId: 'T', roomId: room.id })
    expect(inDefault.roomId).toBeNull()
    expect(inRoom.roomId).toBe(room.id)
    expect(listTasks(db, { teamId: 'T' })).toHaveLength(2)
    expect(listTasks(db, { teamId: 'T', roomId: null }).map((t) => t.id)).toEqual([inDefault.id])
    expect(listTasks(db, { teamId: 'T', roomId: room.id }).map((t) => t.id)).toEqual([inRoom.id])
    expect(getReadyTasks(db, { teamId: 'T', roomId: room.id }).map((t) => t.id)).toEqual([
      inRoom.id,
    ])
    expect(getReadyTasks(db, { teamId: 'T', roomId: null }).map((t) => t.id)).toEqual([
      inDefault.id,
    ])
  })

  it('a subtask inherits its parent room', () => {
    const room = createRoom(db, { teamId: 'T', name: 'A', memberIds: ['a1'] })
    const parent = createTask(db, { title: 'p', teamId: 'T', roomId: room.id })
    expect(createSubtask(db, parent.id, { title: 'c' }).roomId).toBe(room.id)
  })

  it('the fireable scan names the room the work belongs to', () => {
    const room = createRoom(db, { teamId: 'T', name: 'A', memberIds: ['a1'] })
    createTask(db, {
      title: 'deferred',
      teamId: 'T',
      roomId: room.id,
      sourceDelegationId: 'deleg:1:agent:a1:reflectTo:a2',
    })
    expect(listRoomsWithFireableDelegations(db)).toEqual([{ teamId: 'T', roomId: room.id }])
    expect(listTeamsWithFireableDelegations(db)).toEqual(['T'])
  })
})
