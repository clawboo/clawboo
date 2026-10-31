// REST for an agent's 1:1 PERSONAL chat, for every agent the server runs: Clawboo
// Native (including the Boo-Zero personal chat), Claude Code, Codex and Hermes.
// Mirrors the team-chat thin-client surface: POST ingest (persist the user turn +
// drive ONE conversational turn detached → 202) + a GET SSE stream (a pure DB-tail
// of the agent's 1:1 key + the live delta bus). OpenClaw agents keep the Gateway
// 1:1 path; the ingest 404s them.

import {
  chatMessages,
  latestChatMessageId,
  listChatMessagesSince,
  type ClawbooDb,
} from '@clawboo/db'
import type { Request, Response } from 'express'

import {
  agentChatSessionKey,
  driveAgentChat,
  isServerChatAgent,
  stopAgentChat,
} from '../lib/agentChat/driveAgentChat'
import { getDb } from '../lib/db'
import { loopbackMcpBaseUrl } from '../lib/mcpBaseUrl'
import { getAgentStatusSnapshot, subscribeAgentStatus } from '../lib/teamChat/agentStatusBus'
import { subscribeChatDelta } from '../lib/teamChat/chatDeltaBus'

const STREAM_POLL_MS = 750
const STREAM_KEEPALIVE_MS = 20_000

/** Persist the user's message under the agent's 1:1 session so the SSE tail replays
 *  it AND it's durable. Idempotent on entryId (the optimistic client bubble + this
 *  replay share the id → the client dedups). */
function persistUserEntry(db: ClawbooDb, sessionKey: string, text: string, entryId: string): void {
  const now = Date.now()
  try {
    db.insert(chatMessages)
      .values({
        sessionKey,
        gatewayUrl: 'native',
        entryId,
        timestampMs: now,
        data: JSON.stringify({
          entryId,
          role: 'user',
          kind: 'user',
          text,
          sessionKey,
          runId: null,
          source: 'local-send',
          timestampMs: now,
          sequenceKey: now,
          confirmed: true,
          fingerprint: entryId,
        }),
      })
      .onConflictDoNothing()
      .run()
  } catch {
    // best-effort
  }
}

// POST /api/agents/:agentId/chat  { message, displayText?, entryId? }
export function agentChatIngestPOST(req: Request, res: Response): void {
  const agentId = req.params['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }
  const body = req.body as
    { message?: unknown; displayText?: unknown; entryId?: unknown } | undefined
  const message = typeof body?.message === 'string' ? body.message.trim() : ''
  if (!message) {
    res.status(400).json({ error: 'message required' })
    return
  }
  // `displayText` is what shows in the transcript; `message` is the context-injected
  // text delivered to the model (the two differ when the client prepends the rules
  // block / an @team brief). The persisted user turn shows the display text.
  const displayText =
    typeof body?.displayText === 'string' && body.displayText.trim()
      ? body.displayText.trim()
      : message
  const entryId = typeof body?.entryId === 'string' ? body.entryId : `user-${Date.now()}`
  try {
    const db = getDb()
    if (!isServerChatAgent(db, agentId)) {
      res.status(404).json({ error: 'agent does not chat through the server' })
      return
    }
    persistUserEntry(db, agentChatSessionKey(db, agentId), displayText, entryId)
    const mcpBaseUrl = loopbackMcpBaseUrl(req)
    // Detached (the 202 returns now): the reply streams via the SSE + is persisted
    // server-side. Not aborted on client disconnect (a slow reply survives).
    void driveAgentChat({ db, agentId, message, mcpBaseUrl })
    res.status(202).json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// POST /api/agents/:agentId/chat/stop
export async function agentChatStopPOST(req: Request, res: Response): Promise<void> {
  const agentId = req.params['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).json({ error: 'agentId required' })
    return
  }
  try {
    await stopAgentChat(agentId)
    res.json({ ok: true })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// GET /api/agents/:agentId/chat/stream: SSE live-tail of the agent's 1:1 key
// (`agent:<id>:native`, or `agent:<id>:<runtime>` for Claude Code / Codex / Hermes).
// A pure reader (mirrors teamChatStream): Tier 1 = committed rows past an `id`
// cursor, Tier 2 = the in-memory delta bus for live tokens (no `id:`, ephemeral).
export function agentChatStreamGET(req: Request, res: Response): void {
  const agentId = req.params['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).end()
    return
  }
  const lastEventId =
    typeof req.headers['last-event-id'] === 'string' ? req.headers['last-event-id'] : undefined
  const sinceParam = typeof req.query['since'] === 'string' ? req.query['since'] : undefined
  // Resolve the shared connection BEFORE advertising success: a failure here
  // must surface as a real error response, not a 200 plus a ': connected'
  // marker the client has already been told to trust.
  const db = getDb()
  const sessionKey = agentChatSessionKey(db, agentId)

  // A RESUMING client says where it got to and gets everything after that. A FRESH
  // client starts at the head, because it has already loaded the recent page over
  // `/api/chat-history` and this stream's job is the live tail. Starting at 0 sent
  // the entire conversation a second time, which cost nothing while every reset
  // emptied the transcript and costs the whole history now that none does.
  let cursor = Number(lastEventId ?? sinceParam)
  if (!Number.isFinite(cursor) || cursor < 0) {
    cursor =
      lastEventId === undefined && sinceParam === undefined
        ? latestChatMessageId(db, [sessionKey])
        : 0
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

  const poll = (): void => {
    if (closed) return
    try {
      const rows = listChatMessagesSince(db, {
        sessionKeys: [sessionKey],
        afterId: cursor,
        limit: 500,
      })
      for (const r of rows) {
        if (r.id > cursor) cursor = r.id
        res.write(`id: ${r.id}\n`)
        res.write(`data: ${r.data}\n\n`)
      }
    } catch {
      /* transient read error — keep the stream alive; retry next tick */
    }
  }
  poll()

  const unsub = subscribeChatDelta(sessionKey, (delta) => {
    if (closed) return
    res.write('event: delta\n')
    res.write(`data: ${JSON.stringify(delta)}\n\n`)
  })

  // Live working/idle signal for THIS agent's 1:1 turn: a named `status` event
  // with NO `id:` line (ephemeral, off the resume cursor); the client patches the
  // fleet store so the left-pane badge tracks the turn. The connect-time snapshot
  // replay reconciles a badge left stale by a terminal that published while no
  // stream was open (status frames are never cursor-replayed).
  const writeStatus = (update: { agentId: string; status: string }): void => {
    if (closed) return
    res.write('event: status\n')
    res.write(`data: ${JSON.stringify(update)}\n\n`)
  }
  for (const update of getAgentStatusSnapshot(sessionKey)) writeStatus(update)
  const unsubStatus = subscribeAgentStatus(sessionKey, writeStatus)

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
    unsubStatus()
    // No DB handle to close: the tail poll reads through the process-wide shared
    // connection (lib/db.ts getDb). Closing it here would kill SQLite for the
    // WHOLE server the moment any one browser tab drops its stream.
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}
