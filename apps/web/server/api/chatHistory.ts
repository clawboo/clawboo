import type { Request, Response } from 'express'
import { chatMessages, setSetting } from '@clawboo/db'
import { eq, and, asc } from 'drizzle-orm'
import type { TranscriptEntry } from '@clawboo/protocol'
import { getDb } from '../lib/db'
import { nativeChatSessionSettingKey } from '../lib/agentChat/driveAgentChat'
import { nativeTeamSessionSettingKey } from '../lib/teamChat/nativeTeamSession'

// ─── GET /api/chat-history?sessionKey=<key>&limit=<n> ─────────────────────────
// Returns the last N transcript entries for a session, ordered by timestamp ASC.

export async function chatHistoryGET(req: Request, res: Response): Promise<void> {
  const sessionKey = (req.query['sessionKey'] as string | undefined) ?? ''
  const limitParam = req.query['limit'] as string | undefined
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

// ─── DELETE /api/chat-history?sessionKey=<key> ────────────────────────────────
// Clears all messages for a session (used when agent is deleted).

export async function chatHistoryDELETE(req: Request, res: Response): Promise<void> {
  const sessionKey = (req.query['sessionKey'] as string | undefined) ?? ''
  if (!sessionKey) {
    res.status(400).json({ error: 'sessionKey required' })
    return
  }

  try {
    const db = getDb()
    await db.delete(chatMessages).where(and(eq(chatMessages.sessionKey, sessionKey)))
    // A native 1:1 chat carries conversation continuity in a resumable harness session
    // (see driveAgentChat). Clearing its history = a fresh conversation, so drop the
    // resume pointer too — else the model would still "remember" the deleted turns.
    const nativeMatch = sessionKey.match(/^agent:(.+):native$/)
    if (nativeMatch) setSetting(db, nativeChatSessionSettingKey(nativeMatch[1]!), '')
    // A native TEAM session (`agent:<id>:team:<teamId>`) carries the same resumable
    // continuity for the leader/user-facing turn. Clearing its history = a fresh
    // conversation, so drop the per-(agent, team) resume pointer too (else the leader
    // would still "remember" the wiped turns).
    const teamKey = parseTeamSessionKey(sessionKey)
    if (teamKey) setSetting(db, nativeTeamSessionSettingKey(teamKey.agentId, teamKey.teamId), '')
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
