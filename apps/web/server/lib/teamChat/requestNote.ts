// A line saying what a request's answer answers, in the chat that answer lands in.

import type { ClawbooDb, DbTask } from '@clawboo/db'

import { agentIdFromDirectChatKey } from '../agentChat/directChatSessionKey'
import { persistNativeChatEntry } from '../runtimes/native/nativeDriver'
import { persistTeamChatEntry } from './persistTeamChatEntry'

/** A line in the chat a request's answer lands in, saying what it answers: the team's,
 *  or the one-to-one chat the request came from. */
export function writeRequestNote(
  db: ClawbooDb,
  task: DbTask,
  team: { teamId: string; roomId: string | null; agentId: string },
  text: string,
): void {
  const chatAgent = task.chatSessionKey ? agentIdFromDirectChatKey(task.chatSessionKey) : null
  if (task.chatSessionKey && chatAgent)
    persistNativeChatEntry(db, chatAgent, text, {
      sessionKey: task.chatSessionKey,
      kind: 'meta',
      role: 'system',
    })
  else persistTeamChatEntry(db, { ...team, text, role: 'system', kind: 'meta' })
}
