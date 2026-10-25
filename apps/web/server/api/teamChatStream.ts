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
//
// One stream per chat ROOM (`?roomId=`; absent = the team's own group chat): the
// tail reads that room's session keys and forwards only that room's live tokens.
// Board and status frames stay team-wide (the board and the badges are), each
// tagged with the room it came from so a room's composer counts only its own.

import {
  agents,
  getActiveRoom,
  latestChatMessageId,
  listChatMessagesSince,
  listRooms,
  type ClawbooDb,
} from '@clawboo/db'
import { buildTeamSessionKey, parseTeamSessionKey } from '@clawboo/team-orchestration'
import { eq } from 'drizzle-orm'
import type { Request, Response } from 'express'

import { getDb } from '../lib/db'
import { getAgentStatusSnapshot, subscribeAgentStatus } from '../lib/teamChat/agentStatusBus'
import { subscribeBoardChange } from '../lib/teamChat/boardChangeBus'
import { booZeroForTeam } from '../lib/teamChat/booZero'
import { subscribeChatDelta } from '../lib/teamChat/chatDeltaBus'
import { roomMembers } from '../lib/teamChat/roomRoster'

const STREAM_POLL_MS = 750
const STREAM_KEEPALIVE_MS = 20_000

/** The member team-keys of one chat room: the session-key set the tail filters
 *  on. For the team's own group chat (`roomId` null): every agent of the team,
 *  `agent:<id>:team:<teamId>`. For a room: its live members, keyed with the room.
 *  Resolved ONCE at connect (obs-parity); a member added mid-stream is picked up on
 *  the next reconnect. Includes Boo Zero's key (Boo Zero is teamless in the DB but
 *  presides over the team and every room as its universal leader, so its turns
 *  must stream too). */
export function resolveTeamSessionKeys(
  db: ClawbooDb,
  teamId: string,
  roomId: string | null = null,
): string[] {
  const ids =
    roomId === null
      ? (
          db
            .select({ id: agents.id })
            .from(agents)
            .where(eq(agents.teamId, teamId))
            .all() as Array<{
            id: string
          }>
        ).map((r) => r.id)
      : roomMembers(db, teamId, roomId).map((a) => a.id)
  const keys = ids.map((id) => buildTeamSessionKey(id, teamId, roomId))
  const bz = booZeroForTeam(db, teamId)
  if (bz) {
    const bzKey = buildTeamSessionKey(bz.id, teamId, roomId)
    if (!keys.includes(bzKey)) keys.push(bzKey)
  }
  return keys
}

/** Every chat room's keys for a team: its own group chat plus each active room.
 *  For readers that summarize the team as a whole (the activity summary). */
export function resolveAllTeamSessionKeys(db: ClawbooDb, teamId: string): string[] {
  const keys = resolveTeamSessionKeys(db, teamId)
  for (const room of listRooms(db, teamId))
    keys.push(...resolveTeamSessionKeys(db, teamId, room.id))
  return keys
}

export function teamChatStreamGET(req: Request, res: Response): void {
  const teamId = (req.params['id'] as string | undefined) ?? ''
  const lastEventId =
    typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined
  const sinceParam = typeof req.query['since'] === 'string' ? req.query['since'] : undefined
  const roomParam = typeof req.query['roomId'] === 'string' ? req.query['roomId'] : ''
  const roomId = roomParam.length > 0 ? roomParam : null
  // Resolve the shared connection BEFORE advertising success: a failure here
  // must surface as a real error response, not a 200 plus a ': connected'
  // marker the client has already been told to trust.
  const db = getDb()
  if (roomId !== null && !getActiveRoom(db, teamId, roomId)) {
    res.status(404).json({ error: 'room not found' })
    return
  }

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write(': connected\n\n')
  res.flushHeaders?.()

  let closed = false
  const sessionKeys = resolveTeamSessionKeys(db, teamId, roomId)

  // A RESUMING client says where it got to and gets everything after that. A FRESH
  // client starts at the head, because it has already loaded each member's recent
  // page over `/api/chat-history` and this stream's job is the live tail. Starting
  // at 0 re-sent the whole room, which cost nothing while every reset emptied the
  // transcripts and costs the entire history now that none does.
  let cursor = Number(lastEventId ?? sinceParam)
  if (!Number.isFinite(cursor) || cursor < 0) {
    cursor =
      lastEventId === undefined && sinceParam === undefined
        ? latestChatMessageId(db, sessionKeys)
        : 0
  }

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
  // The delta bus is per team, so keep only this room's tokens: a delta whose key
  // names another room (or the team's own group chat, from a room's stream) is
  // someone else's live card.
  const unsub = subscribeChatDelta(teamId, (delta) => {
    if (closed) return
    const parts = parseTeamSessionKey(delta.sessionKey)
    if (!parts || parts.teamId !== teamId || parts.roomId !== roomId) return
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

  // Live agent working/idle signals — forwarded as named `status` events, also with
  // NO `id:` line (EPHEMERAL, off the resume cursor). The thin client patches the
  // fleet store so the left-pane badges track a server-orchestrated cascade live.
  // On connect, REPLAY the channel's last-status snapshot: status frames are never
  // replayed by the cursor, so a client whose stream was closed when a terminal
  // `idle` published would otherwise keep a stale Working badge — and a mid-run
  // connect learns who is already running instead of waiting for the next boundary.
  const writeStatus = (update: { agentId: string; status: string }): void => {
    if (closed) return
    res.write('event: status\n')
    res.write(`data: ${JSON.stringify(update)}\n\n`)
  }
  for (const update of getAgentStatusSnapshot(teamId)) writeStatus(update)
  const unsubStatus = subscribeAgentStatus(teamId, writeStatus)

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
    unsubStatus()
    // No DB handle to close: the tail poll reads through the process-wide shared
    // connection (lib/db.ts getDb). Closing it here would kill SQLite for the
    // WHOLE server the moment any one browser tab drops its stream.
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}
