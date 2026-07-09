// GET /api/teams/:id/chat/stream — SSE live-tail of a team's chat transcript.
//
// Clones the obs /api/obs/stream DB-tail pattern: a short-interval poll over
// `chat_messages` keyed on the monotonic `id` cursor (Tier 1 — committed turns),
// PLUS a subscription to the in-memory chatDeltaBus for live `text-delta` tokens
// (Tier 2 — ephemeral, off the resume cursor).
//
// This is a pure READER: the stream never drives orchestration, so the server-side
// cascade runs to completion with zero clients connected. Resume via the
// EventSource `Last-Event-ID` header or `?since=<id>` — COMMITTED rows only (deltas
// carry no `id` and are never replayed).
//
// Ungated by design: a pure reader of `chat_messages` works for any team's
// transcript. The double-orchestration firewall stays on the WRITE path (the
// `/chat` ingest 404s a non-server-orchestrated team); the thin client opens this
// stream only for server-orchestrated teams.

import { agents, createDb, listChatMessagesSince, type ClawbooDb } from '@clawboo/db'
import { buildTeamSessionKey } from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'

import { getDbPath } from '../lib/db'
import { subscribeBoardChange } from '../lib/teamChat/boardChangeBus'
import { booZeroForTeam } from '../lib/teamChat/booZero'
import { subscribeChatDelta } from '../lib/teamChat/chatDeltaBus'

const STREAM_POLL_MS = 750
const STREAM_KEEPALIVE_MS = 20_000

/** The team's member team-keys (`agent:<id>:team:<teamId>`) — the session-key set
 *  the tail filters on. Resolved ONCE at connect (obs-parity); a member added
 *  mid-stream is picked up on the next reconnect. Includes Boo Zero's team-scoped key
 *  for an OpenClaw team (Boo Zero is teamless in the DB but presides over the team as
 *  its universal leader, so its turns must stream too). */
export function resolveTeamSessionKeys(db: ClawbooDb, teamId: string): string[] {
  const rows = db
    .select({ id: agents.id })
    .from(agents)
    .where(eq(agents.teamId, teamId))
    .all() as Array<{ id: string }>
  const keys = rows.map((r) => buildTeamSessionKey(r.id, teamId))
  const bz = booZeroForTeam(db, teamId)
  if (bz) {
    const bzKey = buildTeamSessionKey(bz.id, teamId)
    if (!keys.includes(bzKey)) keys.push(bzKey)
  }
  return keys
}

export function teamChatStreamGET(req: Request, res: Response): void {
  const teamId = (req.params['id'] as string | undefined) ?? ''
  const lastEventId =
    typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined
  const sinceParam = typeof req.query['since'] === 'string' ? req.query['since'] : undefined
  let cursor = Number(lastEventId ?? sinceParam)
  if (!Number.isFinite(cursor) || cursor < 0) cursor = 0

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
  res.flushHeaders?.()

  let closed = false
  const db = createDb(getDbPath())
  const sessionKeys = resolveTeamSessionKeys(db, teamId)

  // Tier 1 — committed turns. Tail the durable rows past the id cursor; the `data`
  // column is already the serialised TranscriptEntry, written straight to the wire.
  const poll = (): void => {
    if (closed) return
    try {
      const rows = listChatMessagesSince(db, { sessionKeys, afterId: cursor, limit: 500 })
      for (const r of rows) {
        if (r.id > cursor) cursor = r.id
        res.write(`id: ${r.id}\n`)
        res.write(`data: ${r.data}\n\n`)
      }
    } catch {
      /* transient read error — keep the stream alive; retry next tick */
    }
  }
  poll() // flush anything past the cursor immediately

  // Tier 2 — live tokens. Forward the team's in-memory deltas as named `delta`
  // events with NO `id:` line, so they never advance the resume cursor (ephemeral).
  const unsub = subscribeChatDelta(teamId, (delta) => {
    if (closed) return
    res.write('event: delta\n')
    res.write(`data: ${JSON.stringify(delta)}\n\n`)
  })

  // Live board-projection changes — forwarded as named `board` events, also with NO
  // `id:` line (EPHEMERAL, off the resume cursor). The thin client applies each to
  // its board store and reconciles any gap-missed change with a `GET /api/board`
  // reload on (re)connect. So a server cascade's BoardTaskCards update live.
  const unsubBoard = subscribeBoardChange(teamId, (change) => {
    if (closed) return
    res.write('event: board\n')
    res.write(`data: ${JSON.stringify(change)}\n\n`)
  })

  const pollTimer = setInterval(poll, STREAM_POLL_MS)
  const keepalive = setInterval(() => {
    if (!closed) res.write(': keepalive\n\n')
  }, STREAM_KEEPALIVE_MS)
  const cleanup = (): void => {
    if (closed) return
    closed = true
    clearInterval(pollTimer)
    clearInterval(keepalive)
    unsub()
    unsubBoard()
    // Close the per-connection better-sqlite3 handle (createDb opens a FRESH one per
    // SSE stream) so a long-lived/dropped stream doesn't leak a DB handle until GC.
    try {
      db.$client.close()
    } catch {
      /* already closed / never opened */
    }
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}
