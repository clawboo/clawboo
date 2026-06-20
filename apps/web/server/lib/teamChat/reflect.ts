// ─── Board → room reflection (fan-out IS the room) ────────────────────────────
// A board mutation narrates itself into the team room as a `kind:'system'` line.
// This is how reflection fans out to N named peers without a leader-only relay:
// every peer's `team_chat.subscribe` then delivers it (as non-user evidence). The
// leader stays the privileged DECIDER, but is no longer the only LISTENER.
//
// The authority rule is preserved: this runs AFTER a durable board mutation (the
// canonical write already happened in the board repository) — a room line is
// narration, never a write path back to the board. Best-effort: a reflection
// failure must never break the board mutation.

import { postToRoom, resolveRoomForTeam, type ClawbooDb } from '@clawboo/db'

/** Narrate a board mutation into the team's room (a system, non-peer line). */
export function reflectToRoom(
  db: ClawbooDb,
  teamId: string | null | undefined,
  text: string,
): void {
  if (!teamId || !text.trim()) return
  try {
    postToRoom(db, {
      roomId: resolveRoomForTeam(teamId),
      teamId,
      authorAgentId: 'clawboo',
      body: text.trim(),
      kind: 'system',
    })
  } catch {
    /* reflection is best-effort — never break the board mutation */
  }
}
