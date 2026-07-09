// listRecentChatMessages — the "recent N across a key set" read behind the team
// activity summary. Asserts: the MOST-recent N (not the oldest), returned oldest-first
// (chronological), bounded by limit, only the requested keys, empty key set = no-op.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { chatMessages } from '../../schema'
import { listRecentChatMessages } from '../listRecentChatMessages'

let dir: string
let db: ClawbooDb
let seq = 0

function insert(sessionKey: string, text: string): number {
  seq += 1
  const inserted = db
    .insert(chatMessages)
    .values({
      sessionKey,
      gatewayUrl: '',
      entryId: `e${seq}`,
      timestampMs: seq,
      data: JSON.stringify({ entryId: `e${seq}`, sessionKey, text }),
    })
    .returning({ id: chatMessages.id })
    .get() as { id: number }
  return inserted.id
}

const A = 'agent:a1:team:T1'
const B = 'agent:a2:team:T1'
const OTHER = 'agent:a1:native'

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-recent-chat-'))
  db = createDb(path.join(dir, 'test.db'))
  seq = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('listRecentChatMessages', () => {
  it('returns the MOST-recent N across the keys, oldest-first', () => {
    insert(A, 'a1')
    insert(B, 'b1')
    insert(A, 'a2')
    insert(B, 'b2')
    const last = insert(A, 'a3')

    const rows = listRecentChatMessages(db, { sessionKeys: [A, B], limit: 3 })
    // The 3 most recent (a2, b2, a3), in chronological order.
    expect(rows.map((r) => JSON.parse(r.data).text)).toEqual(['a2', 'b2', 'a3'])
    expect(rows[rows.length - 1]!.id).toBe(last)
  })

  it('excludes non-requested session keys', () => {
    insert(A, 'a1')
    insert(OTHER, 'noise')
    insert(A, 'a2')
    const rows = listRecentChatMessages(db, { sessionKeys: [A], limit: 10 })
    expect(rows.map((r) => JSON.parse(r.data).text)).toEqual(['a1', 'a2'])
  })

  it('an empty key set is a no-op (no invalid SQL)', () => {
    insert(A, 'a1')
    expect(listRecentChatMessages(db, { sessionKeys: [], limit: 5 })).toEqual([])
  })
})
