// chatDeltaBus — an in-memory, per-team pub/sub for live assistant-text deltas
// (the SSE stream's Tier-2 ephemeral channel). A `Map<teamId, Set<listener>>` that
// outlives any single SSE connection: serverDeliver's drain PUBLISHES a run's
// running text as it streams; each open team-chat stream SUBSCRIBES and forwards
// it as a named `delta` SSE event.
//
// Deltas are EPHEMERAL — they carry NO durable id and are never replayed on resume
// (the committed `chat_messages` rows are the source of truth; deltas just make a
// turn type out live). With zero subscribers, publish is a no-op, so orchestration
// never blocks on the bus — the "work continues with no client connected" invariant.

/** A live assistant-text delta. `text` is the FULL running text for the run so far
 *  (server-accumulated) — matching the client store's REPLACE semantics, so a
 *  thin client does `setStreamingText(sessionKey, text)` on each one. */
export interface ChatDelta {
  sessionKey: string
  runId: string | null
  text: string
}

type Listener = (delta: ChatDelta) => void

const buses = new Map<string, Set<Listener>>()

/** Publish a delta to every current subscriber of `teamId`. Never throws — a bad
 *  listener (e.g. a write to an already-closed response) is isolated so it can't
 *  kill the orchestrator's drain loop. No subscribers ⇒ a cheap no-op. */
export function publishChatDelta(teamId: string, delta: ChatDelta): void {
  const set = buses.get(teamId)
  if (!set) return
  for (const listener of set) {
    try {
      listener(delta)
    } catch {
      // Isolate a faulty listener — never let it break the drain or sibling streams.
    }
  }
}

/** Subscribe to a team's deltas. Returns an idempotent unsubscribe fn that prunes
 *  the (now-empty) team bucket so the Map doesn't grow unbounded. */
export function subscribeChatDelta(teamId: string, listener: Listener): () => void {
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
