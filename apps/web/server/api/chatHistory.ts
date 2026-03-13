import type { Request, Response } from 'express'
import { createDb, chatMessages } from '@clawboo/db'
import { eq, and, asc } from 'drizzle-orm'
import type { TranscriptEntry } from '@clawboo/protocol'
import { getDbPath } from '../lib/db'

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
    const db = createDb(getDbPath())

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
    const db = createDb(getDbPath())

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

// ─── DELETE /api/chat-history?sessionKey=<key> ────────────────────────────────
// Clears all messages for a session (used when agent is deleted).

export async function chatHistoryDELETE(req: Request, res: Response): Promise<void> {
  const sessionKey = (req.query['sessionKey'] as string | undefined) ?? ''
  if (!sessionKey) {
    res.status(400).json({ error: 'sessionKey required' })
    return
  }

  try {
    const db = createDb(getDbPath())
    await db.delete(chatMessages).where(and(eq(chatMessages.sessionKey, sessionKey)))
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}
