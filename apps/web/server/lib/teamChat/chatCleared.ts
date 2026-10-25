// When a chat was last cleared. Clearing sets a chat's messages aside; the time
// is kept so the chat also stops showing the board tasks made before it (the
// board keeps them).

import { getSetting, type ClawbooDb } from '@clawboo/db'

/** The settings key for a chat's last clear: the team's General chat, or one of
 *  its rooms. */
export function chatClearedSettingKey(teamId: string, roomId: string | null = null): string {
  return roomId ? `team-chat-cleared:${teamId}:room:${roomId}` : `team-chat-cleared:${teamId}`
}

/** When the chat was last cleared (epoch ms), or null when never. */
export function chatClearedAt(
  db: ClawbooDb,
  teamId: string,
  roomId: string | null = null,
): number | null {
  const n = Number(getSetting(db, chatClearedSettingKey(teamId, roomId)))
  return Number.isFinite(n) && n > 0 ? n : null
}
