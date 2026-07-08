// listChatMessagesSince — the durable tail behind the live team-chat SSE stream.
// Asserts the cursor contract: only the requested session keys, strictly after the
// `id` cursor, in `id` ASC order, bounded by `limit`; an empty key set is a no-op.

import { mkdtempSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { chatMessages } from '../../schema'
import { listChatMessagesSince } from '../listChatMessagesSince'

let dir: string
let db: ClawbooDb
let seq = 0

/** Insert a chat_messages row under a session key; returns its autoincrement id. */
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
const ONE_TO_ONE = 'agent:a1:native'

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'clawboo-chat-tail-'))
  db = createDb(path.join(dir, 'test.db'))
  seq = 0
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe('listChatMessagesSince (the live-chat SSE durable tail)', () => {
  it('returns only the requested session keys, after the cursor, in id ASC order', () => {
    const a1 = insert(A, 'a-first')
    insert(ONE_TO_ONE, 'noise — different session key, must be excluded')
    const b1 = insert(B, 'b-first')
    const a2 = insert(A, 'a-second')

    const rows = listChatMessagesSince(db, { sessionKeys: [A, B], afterId: 0 })
    // Excludes the 1:1 key; includes both team keys; ordered by id ASC.
    expect(rows.map((r) => r.id)).toEqual([a1, b1, a2])
    expect(rows.every((r) => r.sessionKey === A || r.sessionKey === B)).toBe(true)
  })

  it('advances on the cursor — only rows with id > afterId', () => {
    const a1 = insert(A, 'one')
    const a2 = insert(A, 'two')
    const a3 = insert(A, 'three')

    const tail = listChatMessagesSince(db, { sessionKeys: [A], afterId: a1 })
    expect(tail.map((r) => r.id)).toEqual([a2, a3])

    const empty = listChatMessagesSince(db, { sessionKeys: [A], afterId: a3 })
    expect(empty).toEqual([])
  })

  it('respects the limit', () => {
    insert(A, '1')
    insert(A, '2')
    insert(A, '3')
    const rows = listChatMessagesSince(db, { sessionKeys: [A], afterId: 0, limit: 2 })
    expect(rows).toHaveLength(2)
  })

  it('an empty session-key set returns [] without querying', () => {
    insert(A, 'present')
    expect(listChatMessagesSince(db, { sessionKeys: [], afterId: 0 })).toEqual([])
  })

  it('carries the serialised TranscriptEntry through the `data` column unchanged', () => {
    insert(A, 'hello world')
    const [row] = listChatMessagesSince(db, { sessionKeys: [A], afterId: 0 })
    expect(JSON.parse(row!.data)).toMatchObject({ sessionKey: A, text: 'hello world' })
  })
})
