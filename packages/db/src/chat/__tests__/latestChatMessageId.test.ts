// The head of a transcript, which is where a live tail must start.
//
// A stream opened with no cursor used to start at 0 and re-send every message ever
// written to the session. That was invisible while starting fresh emptied the
// transcript. It is not invisible now that a conversation is never cleared.

import { beforeEach, describe, expect, it } from 'vitest'

import { createDb, type ClawbooDb } from '../../db'
import { chatMessages } from '../../schema'
import { latestChatMessageId } from '../latestChatMessageId'

let db: ClawbooDb
beforeEach(() => {
  db = createDb(':memory:')
})

const write = (sessionKey: string, n: number): void => {
  for (let i = 0; i < n; i++) {
    db.insert(chatMessages)
      .values({
        sessionKey,
        gatewayUrl: '',
        entryId: `${sessionKey}-${i}`,
        timestampMs: i,
        data: '{}',
      })
      .run()
  }
}

describe('latestChatMessageId', () => {
  it('is the newest row across the given sessions', () => {
    write('a', 3)
    write('b', 2)
    expect(latestChatMessageId(db, ['a'])).toBe(3)
    expect(latestChatMessageId(db, ['a', 'b'])).toBe(5)
  })

  it('ignores sessions it was not asked about', () => {
    write('a', 3)
    write('other', 10)
    expect(latestChatMessageId(db, ['a'])).toBe(3)
  })

  it('is 0 for a conversation that has not started', () => {
    // Correct rather than merely safe: a tail starting at 0 on an empty session
    // sees every message from the first, which is what a new chat wants.
    expect(latestChatMessageId(db, ['nobody'])).toBe(0)
  })

  it('is 0 for no sessions at all, without touching the database', () => {
    expect(latestChatMessageId(db, [])).toBe(0)
  })
})
