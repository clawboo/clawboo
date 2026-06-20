// Per-room re-entrancy guard for the team-chat exchange. An exchange drives real
// model turns and read-modify-writes the room's per-agent leader state (turn
// index + session lineage); two overlapping exchanges for one room would race
// that KV (lost updates) and double-post. This REFUSES an overlapping kickoff
// rather than queueing — a user-triggered "start discussion" must not silently
// stack a second concurrent run. In-process only (the dashboard server is single-
// process); a multi-process horizon would move this to a durable claim row.

const inFlight = new Set<string>()

/** Try to claim the room. Returns false when an exchange is already running for it. */
export function tryAcquireRoom(roomId: string): boolean {
  if (inFlight.has(roomId)) return false
  inFlight.add(roomId)
  return true
}

export function releaseRoom(roomId: string): void {
  inFlight.delete(roomId)
}

/** True while an exchange holds the room (introspection / tests). */
export function isRoomBusy(roomId: string): boolean {
  return inFlight.has(roomId)
}

/** Test-only: clear all in-flight room claims. */
export function resetRoomLocks(): void {
  inFlight.clear()
}
