// The head of a conversation's transcript, for a live tail that must not replay it.
//
// A stream opened with no cursor used to start at 0 and hand the client every
// message ever written to the session, 500 rows a poll. That was invisible while
// starting fresh emptied the transcript, so a conversation was never long. It is not
// invisible now: a conversation is never cleared, and the client has already loaded
// the recent page over `/api/chat-history` before the stream opens, so replaying the
// whole history is both wasted work and a second copy of what is already on screen.
//
// Starting at the head is what makes the stream a TAIL. History has its own route.

import { desc, inArray } from 'drizzle-orm'

import { chatMessages } from '../schema'
import type { ClawbooDb } from '../db'

/**
 * The highest row id across these sessions, or 0 when they hold no messages.
 *
 * 0 is the correct answer for an empty conversation rather than a missing one: a
 * tail that starts at 0 on an empty session sees every message from the first, which
 * is exactly right for a chat that has not started yet.
 */
export function latestChatMessageId(db: ClawbooDb, sessionKeys: string[]): number {
  if (sessionKeys.length === 0) return 0
  const row = db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(inArray(chatMessages.sessionKey, sessionKeys))
    .orderBy(desc(chatMessages.id))
    .limit(1)
    .get()
  return row?.id ?? 0
}
