// boardChangeBus — an in-memory, per-team pub/sub for live BOARD-projection changes
// (the team-chat SSE stream's ephemeral `board` channel). The direct mirror of
// `chatDeltaBus.ts`: a `Map<teamId, Set<listener>>` that outlives any single SSE
// connection. The server orchestrator's engine calls `onBoardChange(change)` on each
// board mutation → `publishBoardChange`; each open team-chat stream SUBSCRIBES and
// forwards it as a named `board` SSE event.
//
// This is a SEPARATE live-push channel from obs — the obs event log is fed
// independently by `serverBoardClient.emitEvent`, so wiring this bus does NOT
// double-emit. Board changes are EPHEMERAL (no durable id, never replayed on
// resume); the committed `chat_messages` rows are the durable transcript, and a thin
// client reconciles missed board changes with a `GET /api/board` reload on
// (re)connect. With zero subscribers, publish is a no-op, so orchestration never
// blocks on the bus — the "work continues with no client connected" invariant.

import type { BoardChange } from '@clawboo/team-orchestration'

type Listener = (change: BoardChange) => void

const buses = new Map<string, Set<Listener>>()

/** Publish a board change to every current subscriber of `teamId`. Never throws — a
 *  bad listener (e.g. a write to an already-closed response) is ISOLATED so it can't
 *  kill the orchestrator's drain loop (`onBoardChange` runs inside the engine's
 *  event handling). No subscribers ⇒ a cheap no-op. */
export function publishBoardChange(teamId: string, change: BoardChange): void {
  const set = buses.get(teamId)
  if (!set) return
  for (const listener of set) {
    try {
      listener(change)
    } catch {
      // Isolate a faulty listener — never let it break the drain or sibling streams.
    }
  }
}

/** Subscribe to a team's board changes. Returns an idempotent unsubscribe fn that
 *  prunes the (now-empty) team bucket so the Map doesn't grow unbounded. */
export function subscribeBoardChange(teamId: string, listener: Listener): () => void {
  let set = buses.get(teamId)
  if (!set) {
    set = new Set()
    buses.set(teamId, set)
  }
  set.add(listener)
  return () => {
    const s = buses.get(teamId)
    if (!s) return
    s.delete(listener)
    if (s.size === 0) buses.delete(teamId)
  }
}
