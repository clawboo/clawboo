import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import path from 'node:path'
import os from 'node:os'
import { createDb, chatMessages } from '@clawboo/db'
import { eq, and, asc } from 'drizzle-orm'
import type { TranscriptEntry } from '@clawboo/protocol'

function getDbPath(): string {
  return path.join(os.homedir(), '.openclaw', 'clawboo', 'clawboo.db')
}

// ─── GET /api/chat-history?sessionKey=<key>&limit=<n> ─────────────────────────
// Returns the last N transcript entries for a session, ordered by timestamp ASC.

export async function GET(req: NextRequest): Promise<NextResponse> {
  const sessionKey = req.nextUrl.searchParams.get('sessionKey') ?? ''
  const limitParam = req.nextUrl.searchParams.get('limit')
  const limit = limitParam ? Math.min(parseInt(limitParam, 10) || 200, 1000) : 200

  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey required' }, { status: 400 })
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
          // Malformed row — skip (shouldn't happen, but be defensive)
          return null
        }
      })
      .filter((e): e is TranscriptEntry => e !== null)

    return NextResponse.json({ entries })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
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

export async function POST(req: NextRequest): Promise<NextResponse> {
  let body: PostBody
  try {
    body = (await req.json()) as PostBody
  } catch {
    return NextResponse.json({ error: 'invalid JSON' }, { status: 400 })
  }

  const { sessionKey, gatewayUrl, entries } = body
  if (!sessionKey || !Array.isArray(entries) || entries.length === 0) {
    return NextResponse.json({ error: 'sessionKey and entries[] required' }, { status: 400 })
  }

  try {
    const db = createDb(getDbPath())

    // Insert each entry; ignore duplicates (idempotent — safe to call multiple times)
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

    return NextResponse.json({ ok: true, saved: entries.length })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}

// ─── DELETE /api/chat-history?sessionKey=<key> ────────────────────────────────
// Clears all messages for a session (used when agent is deleted).

export async function DELETE(req: NextRequest): Promise<NextResponse> {
  const sessionKey = req.nextUrl.searchParams.get('sessionKey') ?? ''
  if (!sessionKey) {
    return NextResponse.json({ error: 'sessionKey required' }, { status: 400 })
  }

  try {
    const db = createDb(getDbPath())
    await db.delete(chatMessages).where(and(eq(chatMessages.sessionKey, sessionKey)))
    return NextResponse.json({ ok: true })
  } catch (err) {
    return NextResponse.json({ error: String(err) }, { status: 500 })
  }
}
