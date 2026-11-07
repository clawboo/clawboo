// Where the team engine hands over a result that belongs to a one-to-one chat: work
// handed off from Boo Zero's chat answers there, so its report-up gets the chat's own
// scope in report_up_outbox (`chat_session_key`) instead of a team and room. No team's
// engine reads such a row; chatHandOffs sends it. Kept apart from chatHandOffs because
// the team orchestrator needs this and chatHandOffs needs the team orchestrator.

import {
  getSetting,
  getTask,
  listUnsettledChatReportUpsOfTeam,
  recordReportUp,
  setSetting,
  type ClawbooDb,
} from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import type { ChatReportUps } from '@clawboo/team-orchestration'

import { parseReportUp } from '../teamChat/reportUpOutbox'
import { agentIdFromDirectChatKey } from './directChatSessionKey'

const log = createLogger('chat-report-ups')

/**
 * A person pressed Stop in this chat. Until their next message, a result that arrives
 * starts no turn and waits for that message, since a person who pressed Stop should not
 * get a paid turn they did not ask for. In the settings table, so a restart keeps it.
 */
export function chatResultsHeldKey(agentId: string): string {
  return `chat-results-held:${agentId}`
}

export function holdChatResults(db: ClawbooDb, agentId: string): void {
  setSetting(db, chatResultsHeldKey(agentId), String(Date.now()))
}

export function releaseChatResults(db: ClawbooDb, agentId: string): void {
  // Only when there is something to lift: most messages come with no Stop before them.
  if (chatResultsHeld(db, agentId)) setSetting(db, chatResultsHeldKey(agentId), '')
}

export function chatResultsHeld(db: ClawbooDb, agentId: string): boolean {
  return Boolean(getSetting(db, chatResultsHeldKey(agentId)))
}

/** When the Stop holding this chat's results came, or nothing with no hold. */
export function chatResultsHeldSince(db: ClawbooDb, agentId: string): string | null {
  return getSetting(db, chatResultsHeldKey(agentId)) || null
}

type ChatReportUpListener = (sessionKey: string) => void

let listener: ChatReportUpListener | null = null

/** Be told when a chat has a report-up to send. One listener: the server's. */
export function onChatReportUp(next: ChatReportUpListener): () => void {
  listener = next
  return () => {
    if (listener === next) listener = null
  }
}

/** A row for this chat was written outside `take`: a person's answer to a plan, in the
 *  answer's own write. Send it now rather than on the dispatch pump's next pass. */
export function notifyChatReportUp(sessionKey: string): void {
  listener?.(sessionKey)
}

export function createChatReportUps(
  db: ClawbooDb,
  teamId: string,
  opts: { onRecorded?: ChatReportUpListener } = {},
): ChatReportUps {
  const onRecorded = opts.onRecorded ?? ((sessionKey: string) => listener?.(sessionKey))
  return {
    take(item, { held }) {
      try {
        const chatSessionKey =
          item.chatSessionKey ?? (item.taskId ? getTask(db, item.taskId)?.chatSessionKey : null)
        if (!chatSessionKey) return false
        const agentId = agentIdFromDirectChatKey(chatSessionKey)
        const waits = held || (agentId !== null && chatResultsHeld(db, agentId))
        recordReportUp(db, {
          teamId,
          roomId: null,
          recipientAgentId: item.toAgentId,
          taskId: item.taskId ?? null,
          payload: JSON.stringify(item),
          chatSessionKey,
          ...(waits ? { held: true } : {}),
        })
        if (!waits) onRecorded(chatSessionKey)
        return true
      } catch (err) {
        // Not lost: the engine sends it to the recipient's team session as it sends
        // any other, so the person still reads the result in the team's chat.
        log.error({ err, teamId, taskId: item.taskId }, 'chat report-up write failed')
        return false
      }
    },
    waiting() {
      try {
        return listUnsettledChatReportUpsOfTeam(db, teamId).flatMap((row) => {
          const item = parseReportUp(row.payload)
          return item ? [item] : []
        })
      } catch (err) {
        log.error({ err, teamId }, 'chat report-up read failed')
        return []
      }
    },
  }
}
