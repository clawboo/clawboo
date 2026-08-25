// The committed-turn writer for a path that taught the connector-ask protocol.
//
// One function because the invariant is one sentence: a reply is persisted with
// its markers stripped, and each distinct ask becomes exactly one card. Two
// dispatchers (the orchestrator's deliver path and the exchange's
// dispatchChatTurn) both owe the reader that sentence, and the first version of
// this feature honoured it on one and not the other.

import type { ClawbooDb } from '@clawboo/db'
import {
  connectorAskBody,
  connectorAskEntryId,
  extractConnectorAsk,
} from '@clawboo/connector-catalog'

import { persistTeamChatEntry } from './persistTeamChatEntry'

/**
 * Persist an assistant turn, stripping any connector-ask markers into a card.
 *
 * Returns what `persistTeamChatEntry` returns for the assistant entry: `false`
 * means the body never reached the transcript, which for a marker-only turn is
 * the intended outcome (the reader gets the card and nothing else, and the
 * caller's clearing delta removes the streamed remnant).
 */
export function persistAssistantTurnWithAsk(
  db: ClawbooDb,
  input: { teamId: string; agentId: string; text: string },
): boolean {
  const ask = extractConnectorAsk(input.text)
  if (ask.slugs.length > 0) {
    try {
      persistTeamChatEntry(db, {
        teamId: input.teamId,
        agentId: input.agentId,
        text: connectorAskBody(ask.slugs),
        role: 'system',
        kind: 'meta',
        // Deterministic per (team, agent, slugs): a re-driven turn or a repeated
        // ask lands on ON CONFLICT DO NOTHING instead of stacking a second
        // identical card under the first.
        entryId: connectorAskEntryId(input.teamId, input.agentId, ask.slugs),
      })
    } catch {
      /* the offer is best-effort: never fail a turn that produced an answer */
    }
  }
  return persistTeamChatEntry(db, {
    teamId: input.teamId,
    agentId: input.agentId,
    text: ask.body,
    role: 'assistant',
    kind: 'assistant',
  })
}
