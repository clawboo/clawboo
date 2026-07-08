// Read the LAST N chat_messages rows across a set of session keys, in chronological
// order. The sibling of listChatMessagesSince (which is ASC + limit = the OLDEST N,
// unusable for "recent"): this fetches DESC + limit (an index-backed reverse
// range-seek over the `(session_key, id)` index) then reverses in JS so the caller
// gets the most-recent N oldest-first. Used to summarise a team's recent activity.

import { desc, inArray } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { chatMessages, type DbChatMessage } from '../schema'

export interface ListRecentChatMessagesFilter {
  /** The session keys to read — typically a team's member team-keys
   *  (`agent:<id>:team:<teamId>`). */
  sessionKeys: string[]
  limit?: number
}

export function listRecentChatMessages(
  db: ClawbooDb,
  filter: ListRecentChatMessagesFilter,
): DbChatMessage[] {
  // An empty key set has no rows — and drizzle's `inArray(col, [])` emits invalid
  // SQL — so short-circuit before touching the DB.
  if (filter.sessionKeys.length === 0) return []
  const rows = db
    .select()
    .from(chatMessages)
    .where(inArray(chatMessages.sessionKey, filter.sessionKeys))
    .orderBy(desc(chatMessages.id))
    .limit(filter.limit ?? 20)
    .all() as DbChatMessage[]
  // DESC gave us the most-recent N; reverse to chronological (oldest-first).
  return rows.reverse()
}
