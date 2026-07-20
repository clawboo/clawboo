// agentStatusBus — an in-memory, per-channel pub/sub for live agent working/idle
// signals (the SSE stream's ephemeral `status` channel). The structural sibling of
// chatDeltaBus: serverDeliver / driveAgentChat PUBLISH at a run's boundaries; each
// open chat SSE stream SUBSCRIBES and forwards the update as a named `status` event
// so the thin client can patch the fleet store (the left-pane Working/Idle badges,
// which nothing else updates for a server-orchestrated run — the Gateway WS path is
// the only other status writer and it never fires for native / server-driven runs).
//
// The channel key is a plain string: a teamId for team-chat streams, a session key
// (`agent:<id>:native`) for the 1:1 native chat stream — exactly how chatDeltaBus is
// keyed by its two publishers. Updates are EPHEMERAL (no durable id, never replayed);
// a client that connects mid-run simply catches the next boundary. Repeated updates
// with the same value are harmless — the fleet store patch is idempotent.

/** One agent's live run-state change. */
export interface AgentStatusUpdate {
  agentId: string
  status: 'running' | 'idle' | 'error'
}

type Listener = (update: AgentStatusUpdate) => void

const buses = new Map<string, Set<Listener>>()

// Last-published status per (channel, agent) — the RECONCILE snapshot. Status
// frames are ephemeral (no id, no replay), so a client whose stream was closed
// when the terminal `idle` published would otherwise keep a stale Working badge
// forever (nothing else writes status for these runs). Each SSE stream replays
// the channel's snapshot on connect; a mid-run connect also learns who is
// ALREADY running from it. Publisher-side ground truth; bounded by the set of
// agents that actually ran this process lifetime.
const lastStatus = new Map<string, Map<string, AgentStatusUpdate['status']>>()

/** Publish a status update to every current subscriber of `channel`. Never throws —
 *  a bad listener (e.g. a write to an already-closed response) is isolated so it
 *  can't kill the run's drain loop. No subscribers ⇒ the snapshot still records it
 *  (the reconcile-on-connect source of truth). */
export function publishAgentStatus(channel: string, update: AgentStatusUpdate): void {
  let snap = lastStatus.get(channel)
  if (!snap) {
    snap = new Map()
    lastStatus.set(channel, snap)
  }
  snap.set(update.agentId, update.status)
  const set = buses.get(channel)
  if (!set) return
  for (const listener of set) {
    try {
      listener(update)
    } catch {
      // Isolate a faulty listener — never let it break the drain or sibling streams.
    }
  }
}

/** The channel's last-published status per agent — replayed by each SSE stream on
 *  connect so a (re)connecting client reconciles stale badges (both directions:
 *  a missed terminal `idle` and a missed `running` start). */
export function getAgentStatusSnapshot(channel: string): AgentStatusUpdate[] {
  const snap = lastStatus.get(channel)
  if (!snap) return []
  return [...snap.entries()].map(([agentId, status]) => ({ agentId, status }))
}

/** Subscribe to a channel's status updates. Returns an idempotent unsubscribe fn
 *  that prunes the (now-empty) bucket so the Map doesn't grow unbounded. */
export function subscribeAgentStatus(channel: string, listener: Listener): () => void {
  let set = buses.get(channel)
  if (!set) {
    set = new Set()
    buses.set(channel, set)
  }
  set.add(listener)
  return () => {
    const s = buses.get(channel)
    if (!s) return
    s.delete(listener)
    if (s.size === 0) buses.delete(channel)
  }
}
