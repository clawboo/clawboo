// REST for a clawboo-native agent's 1:1 PERSONAL chat (the Boo-Zero personal chat +
// any native agent). Mirrors the team-chat thin-client surface: POST ingest
// (persist the user turn + drive ONE conversational turn detached → 202) + a GET SSE
// stream (a pure DB-tail of `agent:<id>:native` + the live delta bus). OpenClaw
// agents keep the Gateway 1:1 path; these routes 404 a non-native agent.

import { chatMessages, createDb, listChatMessagesSince, type ClawbooDb } from '@clawboo/db'
import type { Request, Response } from 'express'

import {
  driveAgentChat,
  isNativeChatAgent,
  nativeChatSessionKey,
  stopAgentChat,
} from '../lib/agentChat/driveAgentChat'
import { getDbPath } from '../lib/db'
import { loopbackMcpBaseUrl } from '../lib/mcpBaseUrl'
import { subscribeChatDelta } from '../lib/teamChat/chatDeltaBus'

const STREAM_POLL_MS = 750
const STREAM_KEEPALIVE_MS = 20_000

/** Persist the user's message under the native 1:1 session so the SSE tail replays
 *  it AND it's durable. Idempotent on entryId (the optimistic client bubble + this
 *  replay share the id → the client dedups). */
function persistUserEntry(
  db: ClawbooDb,
  agentId: string,
  text: string,
  entryId: string,
): void {
  const sessionKey = nativeChatSessionKey(agentId)
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
    | { message?: unknown; displayText?: unknown; entryId?: unknown }
    | undefined
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
    const db = createDb(getDbPath())
    if (!isNativeChatAgent(db, agentId)) {
      res.status(404).json({ error: 'agent is not a native conversational agent' })
      return
    }
    persistUserEntry(db, agentId, displayText, entryId)
    const mcpBaseUrl = loopbackMcpBaseUrl(req)
    // Detached (the 202 returns now): the reply streams via the SSE + is persisted by
    // the native driver. Not aborted on client disconnect (a slow reply survives).
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

// GET /api/agents/:agentId/chat/stream — SSE live-tail of `agent:<id>:native`.
// A pure reader (mirrors teamChatStream): Tier 1 = committed rows past an `id`
// cursor, Tier 2 = the in-memory delta bus for live tokens (no `id:`, ephemeral).
export function agentChatStreamGET(req: Request, res: Response): void {
  const agentId = req.params['agentId'] as string | undefined
  if (!agentId) {
    res.status(400).end()
    return
  }
  const sessionKey = nativeChatSessionKey(agentId)
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

  const poll = (): void => {
    if (closed) return
    try {
      const rows = listChatMessagesSince(db, { sessionKeys: [sessionKey], afterId: cursor, limit: 500 })
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
    try {
      db.$client.close()
    } catch {
      /* already closed / never opened */
    }
  }
  req.on('close', cleanup)
  res.on('close', cleanup)
}
