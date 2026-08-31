// Setting a conversation aside instead of destroying it.

import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { chatMessages } from '../../schema'
import {
  archiveChatSession,
  archivedSessionKey,
  isArchivedSessionKey,
  pruneSessionArchives,
} from '../archiveChatSession'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const write = (sessionKey: string, n: number, at = 1_000) => {
  for (let i = 0; i < n; i++) {
    db.insert(chatMessages)
      .values({
        sessionKey,
        gatewayUrl: 'ws://t',
        entryId: `${sessionKey}-${at}-${i}-${Math.random()}`,
        timestampMs: at + i,
        data: JSON.stringify({ kind: 'user', text: `m${i}` }),
      })
      .run()
  }
}

const liveCount = (key: string) =>
  db
    .select()
    .from(chatMessages)
    .all()
    .filter((r) => r.sessionKey === key).length

describe('archiveChatSession', () => {
  it('moves the messages aside rather than deleting them', () => {
    write('agent:boo:main', 5)
    const moved = archiveChatSession(db, 'agent:boo:main', 9_000)

    expect(moved).toBe(5)
    // Gone from the live key...
    expect(liveCount('agent:boo:main')).toBe(0)
    // ...but every row still exists, under the archive key.
    expect(liveCount(archivedSessionKey('agent:boo:main', 9_000))).toBe(5)
    expect(db.select().from(chatMessages).all()).toHaveLength(5)
  })

  it('leaves other conversations untouched', () => {
    write('agent:boo:main', 3)
    write('agent:other:main', 2)
    archiveChatSession(db, 'agent:boo:main', 9_000)
    expect(liveCount('agent:other:main')).toBe(2)
  })

  it('is a no-op on an already-empty conversation', () => {
    // A second reset must not stack an archive of nothing.
    write('agent:boo:main', 2)
    archiveChatSession(db, 'agent:boo:main', 9_000)
    expect(archiveChatSession(db, 'agent:boo:main', 9_001)).toBe(0)
    expect(db.select().from(chatMessages).all()).toHaveLength(2)
  })

  it('frees the entry ids it takes with it', () => {
    // `entry_id` is uniquely indexed across the WHOLE table and exists only to make
    // an insert idempotent. Some writers key an entry on what it SAYS rather than on
    // when it was said (a connector offer is `connect-ask:<team>:<agent>:<slugs>`, so
    // the same offer cannot stack twice). Leave that id sitting on an archived row and
    // the offer can never be shown again: the insert lands on the conflict and does
    // nothing, in a chat where the original card is no longer on screen.
    db.insert(chatMessages)
      .values({
        sessionKey: 'agent:boo:main',
        gatewayUrl: 'ws://t',
        entryId: 'connect-ask:t1:boo:slack',
        timestampMs: 1,
        data: JSON.stringify({ kind: 'meta', text: 'connect Slack?' }),
      })
      .run()

    archiveChatSession(db, 'agent:boo:main', 9_000)

    // The same id inserts cleanly again, into the fresh conversation.
    expect(() =>
      db
        .insert(chatMessages)
        .values({
          sessionKey: 'agent:boo:main',
          gatewayUrl: 'ws://t',
          entryId: 'connect-ask:t1:boo:slack',
          timestampMs: 2,
          data: JSON.stringify({ kind: 'meta', text: 'connect Slack?' }),
        })
        .run(),
    ).not.toThrow()
    expect(liveCount('agent:boo:main')).toBe(1)
  })

  it('keeps the original entry id inside the row, for anyone reading the archive', () => {
    // Only the COLUMN moves. What a reader renders from is `data`, so the archived
    // conversation still knows what each of its entries was.
    db.insert(chatMessages)
      .values({
        sessionKey: 'agent:boo:main',
        gatewayUrl: 'ws://t',
        entryId: 'e-1',
        timestampMs: 1,
        data: JSON.stringify({ entryId: 'e-1', kind: 'user', text: 'hi' }),
      })
      .run()
    archiveChatSession(db, 'agent:boo:main', 9_000)

    const row = db.select().from(chatMessages).all()[0]!
    expect(row.entryId).not.toBe('e-1')
    expect(JSON.parse(row.data).entryId).toBe('e-1')
  })

  it('produces a key no live key builder could ever produce', () => {
    // Live keys are colon-separated, so a prefix match can never mistake an
    // archive for a live conversation.
    const key = archivedSessionKey('agent:boo:main', 9_000)
    expect(key).toBe('agent:boo:main#reset:9000')
    expect(isArchivedSessionKey(key)).toBe(true)
    expect(isArchivedSessionKey('agent:boo:main')).toBe(false)
    expect(isArchivedSessionKey('agent:boo:team:t1')).toBe(false)
  })
})

describe('pruneSessionArchives', () => {
  it('keeps the newest archives and drops the rest, oldest first', () => {
    // Keeping everything forever with no sweeper is how a local-first install
    // grows a transcript table nobody can explain.
    for (const at of [1_000, 2_000, 3_000]) {
      write('agent:boo:main', 2)
      archiveChatSession(db, 'agent:boo:main', at)
    }
    expect(pruneSessionArchives(db, 'agent:boo:main', 2)).toBe(2)
    expect(liveCount(archivedSessionKey('agent:boo:main', 1_000))).toBe(0)
    expect(liveCount(archivedSessionKey('agent:boo:main', 2_000))).toBe(2)
    expect(liveCount(archivedSessionKey('agent:boo:main', 3_000))).toBe(2)
  })

  it('never touches the live conversation', () => {
    write('agent:boo:main', 2)
    archiveChatSession(db, 'agent:boo:main', 1_000)
    write('agent:boo:main', 3)
    pruneSessionArchives(db, 'agent:boo:main', 0)
    expect(liveCount('agent:boo:main')).toBe(3)
  })

  it('never touches another conversation that shares a prefix', () => {
    // `agent:boo:main` must not sweep `agent:boo:main-2`.
    write('agent:boo:main', 1)
    archiveChatSession(db, 'agent:boo:main', 1_000)
    write('agent:boo:main-2', 1)
    archiveChatSession(db, 'agent:boo:main-2', 1_000)
    pruneSessionArchives(db, 'agent:boo:main', 0)
    expect(liveCount(archivedSessionKey('agent:boo:main-2', 1_000))).toBe(1)
  })

  it('reads an underscore in an agent name as a letter, not a wildcard', () => {
    // `_` matches any character in SQL. Unescaped, sweeping `my_bot` would also
    // sweep `myXbot`, so one person's reset would delete another agent's history.
    write('agent:my_bot:native', 1)
    archiveChatSession(db, 'agent:my_bot:native', 1_000)
    write('agent:myXbot:native', 1)
    archiveChatSession(db, 'agent:myXbot:native', 1_000)
    pruneSessionArchives(db, 'agent:my_bot:native', 0)
    expect(liveCount(archivedSessionKey('agent:myXbot:native', 1_000))).toBe(1)
    expect(liveCount(archivedSessionKey('agent:my_bot:native', 1_000))).toBe(0)
  })

  it('keeps the newest when the stamps are not the same width', () => {
    // Sorting these as strings puts '9999' after '10000', so the sweep would
    // keep the OLDER one and drop the conversation the person just left.
    write('agent:boo:main', 1)
    archiveChatSession(db, 'agent:boo:main', 9_999)
    write('agent:boo:main', 1)
    archiveChatSession(db, 'agent:boo:main', 10_000)
    pruneSessionArchives(db, 'agent:boo:main', 1)
    expect(liveCount(archivedSessionKey('agent:boo:main', 10_000))).toBe(1)
    expect(liveCount(archivedSessionKey('agent:boo:main', 9_999))).toBe(0)
  })
})
