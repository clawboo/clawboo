import type { Request, Response } from 'express'
import {
  archiveChatSession,
  archivedSessionsCondition,
  chatMessages,
  pruneSessionArchives,
  setSetting,
} from '@clawboo/db'
import { eq, and, asc } from 'drizzle-orm'
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

// ─── GET /api/chat-history?sessionKey=<key>&limit=<n> ─────────────────────────
// Returns the last N transcript entries for a session, ordered by timestamp ASC.

export async function chatHistoryGET(req: Request, res: Response): Promise<void> {
  const sessionKey = queryString(req.query['sessionKey'])
  const limitParam = queryString(req.query['limit'])
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 1000) : 200

  if (!sessionKey) {
    res.status(400).json({ error: 'sessionKey required' })
    return
  }

  try {
    const db = getDb()

    const rows = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.sessionKey, sessionKey))
      .orderBy(asc(chatMessages.timestampMs))
      .limit(limit)

    const entries: TranscriptEntry[] = rows
      .map((row) => {
        try {
          return JSON.parse(row.data) as TranscriptEntry
        } catch {
          return null
        }
      })
      .filter((e): e is TranscriptEntry => e !== null)

    res.json({ entries })
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

// ─── Forgetting a conversation ────────────────────────────────────────────────
// Two different intents, deliberately two different verbs.
//
// A RESET means "start fresh". The person wants a clean slate in front of them,
// not their history destroyed. That is the archive route below.
//
// A DELETE means the agent itself is gone, so its conversations go with it. That
// is the only caller of the destructive route (see deleteAgentOperation).
//
// Both drop the resume pointers, because both end the conversation the model is
// still holding: without that, a "fresh" chat would answer from turns the person
// can no longer see.

/** Forget the harness sessions that would otherwise carry old turns forward. */
function dropResumePointers(db: ReturnType<typeof getDb>, sessionKey: string): void {
  // A native 1:1 chat carries conversation continuity in a resumable harness session
  // (see driveAgentChat). Ending its conversation = a fresh one, so drop the resume
  // pointer too, else the model would still "remember" the turns that went away.
  const nativeMatch = sessionKey.match(/^agent:(.+):native$/)
  if (nativeMatch) setSetting(db, nativeChatSessionSettingKey(nativeMatch[1]!), '')
  // A native TEAM session (`agent:<id>:team:<teamId>`) carries the same resumable
  // continuity for the leader/user-facing turn, under a per-(agent, team) pointer.
  const teamKey = parseTeamSessionKey(sessionKey)
  if (teamKey) setSetting(db, nativeTeamSessionSettingKey(teamKey.agentId, teamKey.teamId), '')
}

/**
 * How many past conversations one chat keeps.
 *
 * Old conversations are not hurting anyone, and the runtime underneath keeps its
 * own resets too, but it pairs that with an enforced backstop rather than growing
 * without limit. Twenty is far more than a chat with no history browser can show
 * and small enough that a long-lived install stays explainable.
 */
const ARCHIVES_PER_SESSION = 20

// ─── POST /api/chat-history/archive?sessionKey=<key> ──────────────────────────
// Sets the current conversation aside and leaves the chat empty. Nothing is lost.

export async function chatHistoryARCHIVE(req: Request, res: Response): Promise<void> {
  const sessionKey = queryString(req.query['sessionKey'])
  if (!sessionKey) {
    res.status(400).json({ error: 'sessionKey required' })
    return
  }

  try {
    const db = getDb()
    const archived = archiveChatSession(db, sessionKey)
    pruneSessionArchives(db, sessionKey, ARCHIVES_PER_SESSION)
    dropResumePointers(db, sessionKey)
    res.json({ ok: true, archived })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── DELETE /api/chat-history?sessionKey=<key> ────────────────────────────────
// Destroys a conversation and every past conversation behind it. Used when the
// agent itself is deleted, so nothing is left to browse and nothing is kept.

export async function chatHistoryDELETE(req: Request, res: Response): Promise<void> {
  const sessionKey = queryString(req.query['sessionKey'])
  if (!sessionKey) {
    res.status(400).json({ error: 'sessionKey required' })
    return
  }

  try {
    const db = getDb()
    await db.delete(chatMessages).where(and(eq(chatMessages.sessionKey, sessionKey)))
    // Past conversations live under `<key>#reset:<ts>`, so the exact-key delete
    // above leaves them behind. For a deleted agent that is a leak nothing can
    // reach: the chat that owned them is gone.
    await db.delete(chatMessages).where(archivedSessionsCondition(sessionKey))
    dropResumePointers(db, sessionKey)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
