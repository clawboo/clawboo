// ─── team_chat REST surface ──────────────────────────────────────────────────
// The UI-facing read of the durable team room (the model-facing half is the
// TeamChat MCP server). Shares the same `team_chat` table the MCP server writes
// (one source of truth). Cursor read so the UI can poll incrementally.

import { createDb, readRoom, resolveRoomForTeam } from '@clawboo/db'
import type { Request, Response } from 'express'

import { getDbPath } from '../lib/db'
import { loopbackMcpBaseUrl } from '../lib/mcpBaseUrl'
import { releaseRoom, tryAcquireRoom } from '../lib/teamChat/roomLock'
import { runTeamExchange } from '../lib/teamChat/runTeamExchange'

// GET /api/team-chat?teamId=&roomId=&sinceSeq=&limit=
export function teamChatGET(req: Request, res: Response): void {
  try {
    const q = req.query
    const teamId = typeof q['teamId'] === 'string' ? q['teamId'] : undefined
    const roomId =
      typeof q['roomId'] === 'string'
        ? q['roomId']
        : teamId
          ? resolveRoomForTeam(teamId)
          : undefined
    if (!roomId) {
      res.status(400).json({ error: 'teamId or roomId is required' })
      return
    }
    const sinceSeq = typeof q['sinceSeq'] === 'string' ? Number(q['sinceSeq']) : 0
    const limit = typeof q['limit'] === 'string' ? Number(q['limit']) : undefined
    const posts = readRoom(createDb(getDbPath()), {
      roomId,
      sinceSeq: Number.isFinite(sinceSeq) ? sinceSeq : 0,
      ...(limit && Number.isFinite(limit) ? { limit } : {}),
    })
    const nextSeq = posts.length ? posts[posts.length - 1]!.seq : sinceSeq
    res.json({ roomId, posts, nextSeq })
  } catch (err) {
    res.status(500).json({ error: String(err) })
  }
}

// ─── POST /api/team-chat/exchange ────────────────────────────────────────────
// The explicit production trigger for the mixed-runtime peer-chat engine: run
// ONE bounded exchange for a team (real runtime adapters via dispatchChatTurn;
// speaker/turn-bound lifecycle projected into the obs log). Body:
//   { teamId, stimulus?, firstSpeakers?: string[], maxExchangeTurns? }
// This is a deliberate, invokable kickoff — not an autonomous loop.
export async function teamChatExchangePOST(req: Request, res: Response): Promise<void> {
  const body: Record<string, unknown> =
    req.body && typeof req.body === 'object' ? (req.body as Record<string, unknown>) : {}
  const teamId = typeof body['teamId'] === 'string' ? body['teamId'] : ''
  if (!teamId) {
    res.status(400).json({ error: 'teamId is required' })
    return
  }
  // Per-room re-entrancy guard: refuse an overlapping exchange (it would race the
  // leader-state KV + double-post) rather than queue a second concurrent run.
  const roomId = resolveRoomForTeam(teamId)
  if (!tryAcquireRoom(roomId)) {
    res.status(409).json({ ok: false, error: 'an exchange is already running for this room' })
    return
  }
  // Abort the (potentially minutes-long) exchange when the initiating request
  // disconnects — no further real model turns are dispatched.
  const controller = new AbortController()
  req.on('close', () => controller.abort())
  try {
    const firstSpeakers = Array.isArray(body['firstSpeakers'])
      ? (body['firstSpeakers'] as unknown[]).filter((s): s is string => typeof s === 'string')
      : undefined
    const maxExchangeTurns =
      typeof body['maxExchangeTurns'] === 'number' ? body['maxExchangeTurns'] : undefined
    // The runtime adapters attach their MCP client to THIS server's /api/mcp/* —
    // a server-trusted loopback URL, never the client-supplied Host header.
    const result = await runTeamExchange({
      db: createDb(getDbPath()),
      teamId,
      stimulus: typeof body['stimulus'] === 'string' ? body['stimulus'] : null,
      mcpBaseUrl: loopbackMcpBaseUrl(req),
      signal: controller.signal,
      ...(firstSpeakers && firstSpeakers.length ? { firstSpeakers } : {}),
      ...(maxExchangeTurns != null ? { maxExchangeTurns } : {}),
    })
    if (!result.ok) {
      res
        .status(result.error === 'team not found' ? 404 : 422)
        .json({ ok: false, error: result.error })
      return
    }
    res.json(result)
  } catch (err) {
    res.status(500).json({ error: String(err) })
  } finally {
    releaseRoom(roomId)
  }
}
