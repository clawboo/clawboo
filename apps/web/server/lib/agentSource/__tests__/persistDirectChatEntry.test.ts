// Keeping a one-to-one chat when nobody has a tab open.
//
// These conversations were never bypassing clawboo; the transcript was simply
// only written down while a browser tab happened to be open. Moving the write to
// the server fixes that, and reruns exactly one risk: TWO writers producing two
// rows for one turn. Team chat already hit that and had to be moved to a single
// writer, because each writer minted a fresh random `entryId` and the unique
// index could not collapse them.
//
// So these tests are about identity: the same turn must be the same row, however
// many times the frame arrives.

import { createDb, chatMessages, type ClawbooDb } from '@clawboo/db'
import { beforeEach, describe, expect, it } from 'vitest'

import { persistDirectChatEntry } from '../persistDirectChatEntry'

let db: ClawbooDb

beforeEach(() => {
  db = createDb(':memory:')
})

const rows = (): unknown[] => db.select().from(chatMessages).all()

const base = {
  sessionKey: 'agent:doc-writer-boo:main',
  text: 'I checked the deploy and it is green.',
  messageId: 'msg-42',
}

describe('persistDirectChatEntry', () => {
  it('writes the turn', () => {
    expect(persistDirectChatEntry(db, base)).toBe(true)
    expect(rows()).toHaveLength(1)
  })

  it('is IDEMPOTENT: a redelivered frame lands on the same row', () => {
    // The headline. A reconnect replays recent history, and a random entry id
    // would turn each replay into a fresh copy of the conversation.
    persistDirectChatEntry(db, base)
    persistDirectChatEntry(db, base)
    persistDirectChatEntry(db, base)
    expect(rows()).toHaveLength(1)
  })

  it('keeps two different turns apart', () => {
    persistDirectChatEntry(db, base)
    persistDirectChatEntry(db, { ...base, messageId: 'msg-43', text: 'And the tests pass.' })
    expect(rows()).toHaveLength(2)
  })

  it('keeps the same message id in two sessions apart', () => {
    // OpenClaw's message ids are unique per conversation, not globally, so the
    // session has to be part of the key or one Boo's turn would suppress another's.
    persistDirectChatEntry(db, base)
    persistDirectChatEntry(db, { ...base, sessionKey: 'agent:other-boo:main' })
    expect(rows()).toHaveLength(2)
  })

  it('REFUSES a turn it cannot identify', () => {
    // No message id and no sequence means no way to dedup it, and writing it
    // anyway reintroduces the duplicate this module exists to prevent.
    expect(persistDirectChatEntry(db, { sessionKey: base.sessionKey, text: 'hi' })).toBe(false)
    expect(rows()).toHaveLength(0)
  })

  it('falls back to the sequence number when there is no message id', () => {
    expect(
      persistDirectChatEntry(db, { sessionKey: base.sessionKey, text: 'hi', messageSeq: 7 }),
    ).toBe(true)
    expect(rows()).toHaveLength(1)
  })

  it('drops an empty turn', () => {
    expect(persistDirectChatEntry(db, { ...base, text: '   ' })).toBe(false)
    expect(rows()).toHaveLength(0)
  })
})
