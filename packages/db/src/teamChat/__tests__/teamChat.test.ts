import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { postToRoom, readRoom, resolveRoomForTeam, roomMaxSeq } from '../index'

let dir: string
let db: ClawbooDb

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-teamchat-'))
  db = createDb(path.join(dir, 'test.db'))
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('team_chat substrate', () => {
  it('round-trips a post and assigns a per-room monotonic seq', () => {
    const room = resolveRoomForTeam('tm1')
    const a = postToRoom(db, { roomId: room, teamId: 'tm1', authorAgentId: 'a1', body: 'hello' })
    const b = postToRoom(db, { roomId: room, teamId: 'tm1', authorAgentId: 'a2', body: 'world' })
    expect(a.seq).toBe(1)
    expect(b.seq).toBe(2)
    const all = readRoom(db, { roomId: room })
    expect(all.map((p) => p.authorAgentId)).toEqual(['a1', 'a2'])
    expect(all.map((p) => p.body)).toEqual(['hello', 'world'])
  })

  it('assigns the next seq from MAX(seq) — strictly increasing + unique across many posts', () => {
    // Guards the indexed `ORDER BY seq DESC LIMIT 1` next-seq path (replacing the
    // full-room scan + JS reduce): the output must stay a clean monotonic sequence.
    const room = resolveRoomForTeam('tm1')
    const seqs = Array.from(
      { length: 6 },
      (_, i) =>
        postToRoom(db, { roomId: room, teamId: 'tm1', authorAgentId: `a${i}`, body: String(i) })
          .seq,
    )
    expect(seqs).toEqual([1, 2, 3, 4, 5, 6])
    expect(new Set(seqs).size).toBe(seqs.length)
  })

  it('seq is per-room, not global', () => {
    const r1 = resolveRoomForTeam('tm1')
    const r2 = resolveRoomForTeam('tm2')
    expect(postToRoom(db, { roomId: r1, teamId: 'tm1', authorAgentId: 'a1', body: 'x' }).seq).toBe(
      1,
    )
    expect(postToRoom(db, { roomId: r2, teamId: 'tm2', authorAgentId: 'b1', body: 'y' }).seq).toBe(
      1,
    )
    expect(postToRoom(db, { roomId: r1, teamId: 'tm1', authorAgentId: 'a1', body: 'z' }).seq).toBe(
      2,
    )
  })

  it('readRoom honours the sinceSeq cursor', () => {
    const room = resolveRoomForTeam('tm1')
    postToRoom(db, { roomId: room, teamId: 'tm1', authorAgentId: 'a1', body: '1' })
    postToRoom(db, { roomId: room, teamId: 'tm1', authorAgentId: 'a1', body: '2' })
    postToRoom(db, { roomId: room, teamId: 'tm1', authorAgentId: 'a1', body: '3' })
    const tail = readRoom(db, { roomId: room, sinceSeq: 1 })
    expect(tail.map((p) => p.body)).toEqual(['2', '3'])
  })

  it('excludeAuthorId is the per-(room,author) echo guard — a poster never sees its own posts', () => {
    const room = resolveRoomForTeam('tm1')
    postToRoom(db, { roomId: room, teamId: 'tm1', authorAgentId: 'leader', body: 'plan it' })
    postToRoom(db, { roomId: room, teamId: 'tm1', authorAgentId: 'worker', body: 'on it' })
    postToRoom(db, { roomId: room, teamId: 'tm1', authorAgentId: 'leader', body: 'thanks' })
    const forLeader = readRoom(db, { roomId: room, excludeAuthorId: 'leader' })
    expect(forLeader.map((p) => p.authorAgentId)).toEqual(['worker'])
    const forWorker = readRoom(db, { roomId: room, excludeAuthorId: 'worker' })
    expect(forWorker.map((p) => p.body)).toEqual(['plan it', 'thanks'])
  })

  it('roomMaxSeq returns the room head regardless of author (0 for an empty room)', () => {
    const room = resolveRoomForTeam('tm1')
    expect(roomMaxSeq(db, room)).toBe(0)
    postToRoom(db, { roomId: room, teamId: 'tm1', authorAgentId: 'a1', body: '1' })
    postToRoom(db, { roomId: room, teamId: 'tm1', authorAgentId: 'a1', body: '2' })
    // The head is the MAX(seq) with NO author filter — a poster's own latest post
    // still counts (this is the cursor a subscriber advances to, past its own posts).
    expect(roomMaxSeq(db, room)).toBe(2)
    expect(roomMaxSeq(db, resolveRoomForTeam('empty'))).toBe(0)
  })

  it('carries teamId + kind on every row (the tenant-scopable seam + narration distinction)', () => {
    const room = resolveRoomForTeam('tm1')
    const peer = postToRoom(db, { roomId: room, teamId: 'tm1', authorAgentId: 'a1', body: 'p' })
    const sys = postToRoom(db, {
      roomId: room,
      teamId: 'tm1',
      authorAgentId: 'clawboo',
      body: 'task done',
      kind: 'system',
    })
    expect(peer.teamId).toBe('tm1')
    expect(peer.kind).toBe('peer')
    expect(sys.kind).toBe('system')
  })
})
