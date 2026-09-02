import type { Request, Response } from 'express'
import { chatMessages, setSetting } from '@clawboo/db'
import { randomUUID } from 'node:crypto'
import { eq, and, desc, lt } from 'drizzle-orm'
import type { TranscriptEntry } from '@clawboo/protocol'
import { getDb } from '../lib/db'
import { nativeChatSessionSettingKey } from '../lib/agentChat/driveAgentChat'
import { nativeTeamSessionSettingKey } from '../lib/teamChat/nativeTeamSession'

/**
 * One query parameter as a string, or '' for anything else.
 *
 * The TYPE of a query value is the caller's choice, not ours: a repeated key
 * (`?k=a&k=b`) arrives as an array and a bracketed one (`?k[x]=y`) as an object.
 * A cast says otherwise but checks nothing, so an array would reach the string
 * methods below and the database comparison as an array. Narrowing here means
 * every reader downstream really is handling a string.
 */
function queryString(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

// ─── GET /api/chat-history?sessionKey=<key>&limit=<n>&before=<rowId> ──────────
// Returns a page of transcript entries for a session, oldest-first within the page.
//
// THE PAGE IS THE MOST RECENT ONE, which is not what this route used to do. It
// ordered ASC and took the first N, so a conversation longer than the limit opened
// on its OLDEST messages with the recent ones simply absent. Nothing caught it
// because starting fresh used to empty the transcript, so no chat ever got long
// enough to notice. Now that a conversation is never cleared, every long-lived chat
// would hit it, so the page walks BACKWARD from the newest row.
//
// `before` is a row id from a previous response's `nextBefore`, which is how the
// chat scrolls further back. A row id rather than a timestamp: it is unique and
// monotonic, so a page boundary can never straddle two entries sharing one
// millisecond, and the caller never has to have kept a row's timestamp.

export async function chatHistoryGET(req: Request, res: Response): Promise<void> {
  const sessionKey = queryString(req.query['sessionKey'])
  const limitParam = queryString(req.query['limit'])
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 1000) : 200
  const beforeParam = queryString(req.query['before'])
  const before = beforeParam ? Number.parseInt(beforeParam, 10) : Number.NaN

  if (!sessionKey) {
    res.status(400).json({ error: 'sessionKey required' })
    return
  }

  try {
    const db = getDb()

    const where = Number.isSafeInteger(before)
      ? and(eq(chatMessages.sessionKey, sessionKey), lt(chatMessages.id, before))
      : eq(chatMessages.sessionKey, sessionKey)

    // Ask for one more row than requested: whether that extra row exists answers
    // "is there anything further back" without a second COUNT query.
    const rows = await db
      .select()
      .from(chatMessages)
      .where(where)
      .orderBy(desc(chatMessages.id))
      .limit(limit + 1)

    const hasMore = rows.length > limit
    const page = hasMore ? rows.slice(0, limit) : rows
    // Oldest-first, the order every existing reader of this route expects.
    page.reverse()

    const entries: TranscriptEntry[] = page
      .map((row) => {
        try {
          return JSON.parse(row.data) as TranscriptEntry
        } catch {
          return null
        }
      })
      .filter((e): e is TranscriptEntry => e !== null)

    res.json({
      entries,
      hasMore,
      // The cursor for the next page back, or null once this page reached the start.
      nextBefore: hasMore ? (page[0]?.id ?? null) : null,
    })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/chat-history ────────────────────────────────────────────────────
// Body: { sessionKey: string, gatewayUrl: string, entries: TranscriptEntry[] }
// Batch-inserts entries; ON CONFLICT (entry_id) DO NOTHING for idempotency.

type PostBody = {
  sessionKey: string
  gatewayUrl: string
  entries: TranscriptEntry[]
}

export async function chatHistoryPOST(req: Request, res: Response): Promise<void> {
  const body = req.body as PostBody | undefined
  if (!body || typeof body !== 'object') {
    res.status(400).json({ error: 'invalid JSON' })
    return
  }

  const { sessionKey, gatewayUrl, entries } = body
  if (!sessionKey || !Array.isArray(entries) || entries.length === 0) {
    res.status(400).json({ error: 'sessionKey and entries[] required' })
    return
  }

  try {
    const db = getDb()

    for (const entry of entries) {
      if (!entry?.entryId) continue
      await db
        .insert(chatMessages)
        .values({
          sessionKey,
          gatewayUrl: gatewayUrl ?? '',
          entryId: entry.entryId,
          timestampMs: entry.timestampMs ?? Date.now(),
          data: JSON.stringify(entry),
        })
        .onConflictDoNothing()
    }

    res.json({ ok: true, saved: entries.length })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── Session-key parsing ──────────────────────────────────────────────────────

/** Parse a team session key (`agent:<agentId>:team:<teamId>`) into its ids, or
 *  null when the key isn't team-shaped. The key arrives verbatim from the query
 *  string, so the parse is plain single-pass string scanning: cost stays linear
 *  no matter how many `:team:` fragments a hostile key packs in. Ids are
 *  colon-free in practice (native agent ids are slugs, team ids are UUIDs); if a
 *  key does embed extra `:team:` fragments, the rightmost one with a non-empty
 *  id on each side is the separator. */
export function parseTeamSessionKey(
  sessionKey: string,
): { agentId: string; teamId: string } | null {
  const prefix = 'agent:'
  const sep = ':team:'
  // Ids never contain line breaks; a key smuggling one is malformed input.
  if (!sessionKey.startsWith(prefix) || /[\r\n\u2028\u2029]/.test(sessionKey)) return null
  const rest = sessionKey.slice(prefix.length)
  let at = rest.lastIndexOf(sep)
  // A key ending exactly in `:team:` has an empty team id at that occurrence;
  // fall back to the previous one (which always has a non-empty tail).
  if (at !== -1 && at + sep.length === rest.length) at = rest.lastIndexOf(sep, at - 1)
  if (at <= 0) return null
  return { agentId: rest.slice(0, at), teamId: rest.slice(at + sep.length) }
}

// ─── Ending a conversation ────────────────────────────────────────────────────
// Two different intents, deliberately two different verbs.
//
// STARTING FRESH means "carry none of this into your next reply". It is about the
// model's context, not about the person's history, so it moves NO messages: the
// chat keeps everything on screen and gains a divider marking where the boo's
// memory of the conversation stops. That is the route below.
//
// DELETING means the agent itself is gone, so its conversation goes with it. That
// is the only caller of the destructive route (see deleteAgentOperation).

/** Forget the harness sessions that would otherwise carry old turns forward. */
function dropResumePointers(db: ReturnType<typeof getDb>, sessionKey: string): void {
  // A native 1:1 chat carries conversation continuity in a resumable harness session
  // (see driveAgentChat). Starting fresh means the next turn must not resume it.
  const nativeMatch = sessionKey.match(/^agent:(.+):native$/)
  if (nativeMatch) setSetting(db, nativeChatSessionSettingKey(nativeMatch[1]!), '')
  // A native TEAM session (`agent:<id>:team:<teamId>`) carries the same resumable
  // continuity for the leader/user-facing turn, under a per-(agent, team) pointer.
  const teamKey = parseTeamSessionKey(sessionKey)
  if (teamKey) setSetting(db, nativeTeamSessionSettingKey(teamKey.agentId, teamKey.teamId), '')
}

/**
 * What the chat shows at the point the boo's memory of it stops.
 *
 * Persisted, unlike the old notice, because it is now a permanent landmark in a
 * transcript that outlives the reset: scrolling past it later is how a person
 * understands why the boo does not recall what is written above it.
 *
 * The second sentence is the honest half. A reset drops the conversation but not the
 * boo's saved notes, which it is handed back on its next turn (see memoryRecall), and
 * "anything it saved" is true whether that turns out to be a lot or nothing at all.
 */
export const CONTEXT_DIVIDER_TEXT =
  'Starting fresh from here. Everything above stays for you to read. Your boo is no longer carrying the conversation, though it still has anything it saved to memory.'

// ─── POST /api/chat-history/reset-context ─────────────────────────────────────
// Body: { sessionKeys: string[], noticeSessionKey?: string }
// Ends the model's conversation on every listed key and drops ONE divider into the
// transcript. Touches no existing message.

type ResetContextBody = { sessionKeys?: unknown; noticeSessionKey?: unknown }

export async function chatHistoryRESETCONTEXT(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as ResetContextBody
  const keys = Array.isArray(body.sessionKeys)
    ? body.sessionKeys.filter((k): k is string => typeof k === 'string' && k.length > 0)
    : []
  if (keys.length === 0) {
    res.status(400).json({ error: 'sessionKeys[] required' })
    return
  }
  // One divider, even for a team room, where every teammate's context resets but
  // the person is looking at a single merged timeline.
  const noticeKey = typeof body.noticeSessionKey === 'string' ? body.noticeSessionKey : keys[0]!
  if (!keys.includes(noticeKey)) {
    res.status(400).json({ error: 'noticeSessionKey must be one of sessionKeys' })
    return
  }

  try {
    const db = getDb()
    for (const key of keys) dropResumePointers(db, key)

    const now = Date.now()
    const entryId = `context-reset-${randomUUID()}`
    const entry: TranscriptEntry = {
      entryId,
      runId: null,
      sessionKey: noticeKey,
      kind: 'meta',
      role: 'system',
      text: CONTEXT_DIVIDER_TEXT,
      source: 'local-send',
      timestampMs: now,
      sequenceKey: now,
      confirmed: true,
      fingerprint: entryId,
    }
    await db
      .insert(chatMessages)
      .values({
        sessionKey: noticeKey,
        gatewayUrl: '',
        entryId,
        timestampMs: now,
        data: JSON.stringify(entry),
      })
      .onConflictDoNothing()

    res.json({ ok: true, entry })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── DELETE /api/chat-history?sessionKey=<key> ────────────────────────────────
// Destroys every message for a session. Used when the agent itself is deleted.

export async function chatHistoryDELETE(req: Request, res: Response): Promise<void> {
  const sessionKey = queryString(req.query['sessionKey'])
  if (!sessionKey) {
    res.status(400).json({ error: 'sessionKey required' })
    return
  }

  try {
    const db = getDb()
    await db.delete(chatMessages).where(and(eq(chatMessages.sessionKey, sessionKey)))
    dropResumePointers(db, sessionKey)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
