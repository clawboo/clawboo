// Set a conversation aside without destroying it.
//
// WHY RE-KEY RATHER THAN DELETE. `/reset` means "let us start fresh", and the
// loudest documented pain across every product surveyed is losing a conversation,
// never having too many. Deleting was also inconsistent: the native path wiped
// every row while the Gateway path kept them, so the same two words meant
// "destroy" or "keep" depending on which runtime an agent happened to run on.
//
// WHY RE-KEY RATHER THAN AN `archived_at` COLUMN. Four separate places read
// chat_messages by exact session key, and a flag would need every one of them to
// remember to filter it. A key that no longer matches is filtered by construction,
// so a reader that forgets nothing can leak nothing. It also needs no schema
// change, and it mirrors what the runtime underneath already does: OpenClaw
// renames a reset transcript to `<file>.reset.<timestamp>` and keeps it.
//
// THE SUFFIX IS DELIBERATELY NOT A VALID LIVE KEY. Live keys are colon-separated
// (`agent:<id>:main`), so a `#` cannot be produced by any key builder and an
// archived row can never be mistaken for a live one by a prefix match.

import { eq, sql, type SQL } from 'drizzle-orm'

import { chatMessages } from '../schema'
import type { ClawbooDb } from '../db'

/** Separates a live key from its archive stamp. Never appears in a live key. */
const ARCHIVE_MARK = '#reset:'

/**
 * Match every archive of ONE conversation.
 *
 * The prefix is a session key, and a session key carries an agent id a person
 * chose. `%` and `_` are wildcards to SQL but ordinary characters in a name, so
 * an agent called `my_bot` would otherwise match `myXbot` and one conversation's
 * sweep would reach into another's archives. Escaping is what keeps the pattern
 * meaning exactly the prefix it was given.
 */
function archivesOf(sessionKey: string): SQL {
  const prefix = `${sessionKey}${ARCHIVE_MARK}`.replace(/[\\%_]/g, (c) => `\\${c}`)
  return sql`${chatMessages.sessionKey} LIKE ${`${prefix}%`} ESCAPE '\\'`
}

/** The key an archive of `sessionKey` taken at `at` is stored under. */
export function archivedSessionKey(sessionKey: string, at: number): string {
  return `${sessionKey}${ARCHIVE_MARK}${at}`
}

/** True when this key holds a conversation that was reset away. */
export function isArchivedSessionKey(sessionKey: string): boolean {
  return sessionKey.includes(ARCHIVE_MARK)
}

/**
 * Move every message under `sessionKey` aside, and report how many moved.
 *
 * Idempotent in the way that matters: a second call finds nothing under the live
 * key and moves nothing, rather than stacking a second archive of an empty
 * conversation.
 */
export function archiveChatSession(db: ClawbooDb, sessionKey: string, at = Date.now()): number {
  const rows = db
    .select({ id: chatMessages.id })
    .from(chatMessages)
    .where(eq(chatMessages.sessionKey, sessionKey))
    .all()
  if (rows.length === 0) return 0

  db.update(chatMessages)
    .set({ sessionKey: archivedSessionKey(sessionKey, at) })
    .where(eq(chatMessages.sessionKey, sessionKey))
    .run()
  return rows.length
}

/**
 * Drop archives of one conversation, oldest first, keeping the newest `keep`.
 *
 * "Old chats are not hurting anyone" is the right instinct and it is what the
 * runtime underneath does too, but upstream pairs it with an enforced backstop:
 * a 30 day prune and a 500 entry cap. Keeping everything with no sweeper is how
 * a local-first install grows a transcript table nobody can explain.
 */
export function pruneSessionArchives(db: ClawbooDb, sessionKey: string, keep: number): number {
  const archives = db
    .select({ key: chatMessages.sessionKey })
    .from(chatMessages)
    .where(archivesOf(sessionKey))
    .all()
  // Oldest first, by the stamp itself rather than by string order: the two agree
  // for every timestamp of the same width, and stop agreeing the moment one is not.
  const stampOf = (key: string): number =>
    Number(key.slice(key.indexOf(ARCHIVE_MARK) + ARCHIVE_MARK.length))
  const keys = [...new Set(archives.map((a) => a.key))].sort((a, b) => stampOf(a) - stampOf(b))
  const doomed = keys.slice(0, Math.max(0, keys.length - keep))
  let removed = 0
  for (const key of doomed) {
    const n = db
      .select({ id: chatMessages.id })
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, key))
      .all().length
    db.delete(chatMessages).where(eq(chatMessages.sessionKey, key)).run()
    removed += n
  }
  return removed
}

/** Every archive of one conversation, for a caller that is removing it entirely. */
export function archivedSessionsCondition(sessionKey: string): SQL {
  return archivesOf(sessionKey)
}
