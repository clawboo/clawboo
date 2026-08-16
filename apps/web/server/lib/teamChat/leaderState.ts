// ─── Between-turn leader/peer state (worktree-less chat turns) ────────────────
// A conversational reduce produces no code deliverable, so a chat turn has NO
// worktree — and therefore no `AGENT_HANDOFF.json` to carry the heartbeat-restore
// state. We keep the same CONCEPT (the serialized state a one-shot runtime needs
// to resume mid-room between turns) in a small SQLite KV: the room cursor (last
// seen `seq`), the native session id (same-runtime resume handle), and the last
// turn summary. This mirrors the `roomCursor` + `nativeSessionId` fields the
// handoff schema now also carries for the worktree-backed leader variant.
//
// Keyed per (roomId, agentId). Settings-KV, no migration (board-store precedent).

import { getSetting, setSetting, type ClawbooDb } from '@clawboo/db'

import { redactObject } from '../redact'

export interface ChatLeaderState {
  /** Last per-room post `seq` this runtime had already seen at clock-out. */
  lastSeenSeq: number
  /** Native session id for same-runtime resume (null on a fresh / cross-runtime turn). */
  nativeSessionId: string | null
  /** The runtime that produced this state (resume only when it matches). */
  runtime: string
  /** Concise summary of the last turn (cheap context for the next turn). */
  lastSummary: string
  /** 1-based count of turns this leader/peer has taken in the room. */
  turnIndex: number
}

const DEFAULT_STATE: ChatLeaderState = {
  lastSeenSeq: 0,
  nativeSessionId: null,
  runtime: '',
  lastSummary: '',
  turnIndex: 0,
}

function key(roomId: string, agentId: string): string {
  return `team-chat-leader-state:${roomId}:${agentId}`
}

export function loadChatLeaderState(
  db: ClawbooDb,
  roomId: string,
  agentId: string,
): ChatLeaderState {
  const raw = getSetting(db, key(roomId, agentId))
  if (!raw) return { ...DEFAULT_STATE }
  try {
    const parsed = JSON.parse(raw) as Partial<ChatLeaderState>
    return {
      lastSeenSeq: typeof parsed.lastSeenSeq === 'number' ? parsed.lastSeenSeq : 0,
      nativeSessionId: typeof parsed.nativeSessionId === 'string' ? parsed.nativeSessionId : null,
      runtime: typeof parsed.runtime === 'string' ? parsed.runtime : '',
      lastSummary: typeof parsed.lastSummary === 'string' ? parsed.lastSummary : '',
      turnIndex: typeof parsed.turnIndex === 'number' ? parsed.turnIndex : 0,
    }
  } catch {
    return { ...DEFAULT_STATE }
  }
}

export function saveChatLeaderState(
  db: ClawbooDb,
  roomId: string,
  agentId: string,
  state: ChatLeaderState,
): void {
  // The summary is model-authored text — redact any leaked credential before it
  // lands in a durable settings row (display/storage defense-in-depth).
  const safe = redactObject(state) as ChatLeaderState
  setSetting(db, key(roomId, agentId), JSON.stringify(safe))
}

/**
 * Advance ONLY the room cursor, leaving every other field as it was.
 *
 * Two paths deliver room posts to the same agent: the browser exchange
 * (`dispatchChatTurn`, which clocks out a whole state) and the server-orchestrated
 * run (`serverDeliver`, which only ever learns "these posts were handed over").
 * They share one cursor on purpose, since it answers a single question, so the
 * orchestrated side must not clobber the exchange's session id or summary by
 * writing a full state it does not own.
 *
 * MONOTONIC: never moves the cursor backwards. A concurrent writer that already
 * advanced past `seq` has delivered more, not less, and rewinding would re-deliver
 * posts the agent has seen.
 */
export function advanceChatLeaderSeq(
  db: ClawbooDb,
  roomId: string,
  agentId: string,
  seq: number,
): void {
  const prior = loadChatLeaderState(db, roomId, agentId)
  if (seq <= prior.lastSeenSeq) return
  saveChatLeaderState(db, roomId, agentId, { ...prior, lastSeenSeq: seq })
}
