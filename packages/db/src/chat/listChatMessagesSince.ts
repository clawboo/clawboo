// Read new chat_messages rows for a set of session keys after an id cursor — the
// durable tail behind the live team-chat SSE stream. Mirrors events/listEvents:
// the cursor is the autoincrement `id` (a globally monotonic rowid alias), so a
// poll seeks strictly past the last-seen row. The `(session_key, id)` index makes
// each poll an O(new-rows) range-seek per key instead of an O(history) scan + sort.

import { and, asc, gt, inArray } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { chatMessages, type DbChatMessage } from '../schema'

export interface ListChatMessagesSinceFilter {
  /** The session keys to tail — typically a team's member team-keys
   *  (`agent:<id>:team:<teamId>`). */
  sessionKeys: string[]
  /** `id >` cursor (the autoincrement primary key). 0 reads from the start. */
  afterId: number
  limit?: number
}

export function listChatMessagesSince(
  db: ClawbooDb,
  filter: ListChatMessagesSinceFilter,
): DbChatMessage[] {
  // An empty key set has no rows — and drizzle's `inArray(col, [])` emits invalid
  // SQL — so short-circuit before touching the DB.
  if (filter.sessionKeys.length === 0) return []
  return db
    .select()
    .from(chatMessages)
    .where(
      and(
        inArray(chatMessages.sessionKey, filter.sessionKeys),
        gt(chatMessages.id, filter.afterId),
      ),
    )
    .orderBy(asc(chatMessages.id))
    .limit(filter.limit ?? 500)
    .all() as DbChatMessage[]
}
