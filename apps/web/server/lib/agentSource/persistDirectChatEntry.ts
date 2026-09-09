// Keep a Boo's one-to-one chat even when nobody has a tab open.
//
// THE BUG, and it is not the one it looks like. These conversations were never
// bypassing clawboo: every message already travels through its server. What was
// missing is that the transcript was only WRITTEN DOWN as a side effect of the
// browser having a tab open. Close the tab, and the conversation happened and was
// never recorded. Reload later and it is simply gone.
//
// THE PRECEDENT IS ALREADY IN THIS CODEBASE. Team sessions were moved to a single
// server writer (`persistTeamChatEntry`) and the browser now deliberately skips
// them, because two writers produced a fresh random `entryId` each and the unique
// index could not collapse the copies. This is that same move, applied to the
// one-to-one case, and it copies the fix that made it work: a DETERMINISTIC entry
// id, so a redelivered frame lands on the existing row instead of beside it.

import { chatMessages, type ClawbooDb } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import type { TranscriptEntry } from '@clawboo/protocol'
import { shouldDropAssistantTurn } from '@clawboo/team-orchestration'

const log = createLogger('direct-chat')

/** Same-millisecond tiebreaker; the merged client sort is timestamp then this. */
let seqCounter = 0

export interface DirectChatEntryInput {
  sessionKey: string
  text: string
  /** OpenClaw's own id for this transcript row; the basis of the deterministic entry id. */
  messageId?: string | undefined
  messageSeq?: number | undefined
  runId?: string | null | undefined
}

/**
 * The entry id for a committed row.
 *
 * DERIVED, NEVER RANDOM. `uniq_chat_messages_entry_id` is what stops the same
 * turn appearing twice, and a random id defeats it completely: that is exactly
 * why team chat had to move to one writer. Deriving the id from OpenClaw's own
 * message id makes a redelivered frame idempotent, so a reconnect that replays
 * recent history costs nothing instead of duplicating the conversation.
 *
 * Falls back to the sequence number, and refuses when there is neither: an entry
 * we cannot identify is one we cannot dedup, and writing it would reintroduce the
 * duplicate this exists to prevent.
 */
function entryIdFor(input: DirectChatEntryInput): string | null {
  if (input.messageId) return `oc:${input.sessionKey}:${input.messageId}`
  if (typeof input.messageSeq === 'number') return `oc:${input.sessionKey}:seq:${input.messageSeq}`
  return null
}

/**
 * Persist one assistant turn of a one-to-one chat. Best-effort and idempotent.
 *
 * Returns whether a row is now in the transcript, which includes the conflict
 * no-op: the entry is there either way.
 */
export function persistDirectChatEntry(db: ClawbooDb, input: DirectChatEntryInput): boolean {
  const text = input.text.trim()
  if (!text) return false
  // The same write-time drop the team writer applies, so a control token never
  // reaches the transcript and a thin client that skips the render filter still
  // shows a clean chat.
  if (shouldDropAssistantTurn(text)) return false

  const entryId = entryIdFor(input)
  if (!entryId) return false

  const now = Date.now()
  const entry: TranscriptEntry = {
    entryId,
    role: 'assistant',
    kind: 'assistant',
    text,
    sessionKey: input.sessionKey,
    runId: input.runId ?? null,
    source: 'runtime-chat',
    timestampMs: now,
    sequenceKey: ++seqCounter,
    confirmed: true,
    // Deterministic for the same reason as the entry id: a random value here
    // would make an idempotent rewrite look like a different utterance.
    fingerprint: entryId,
  }

  try {
    db.insert(chatMessages)
      .values({
        sessionKey: input.sessionKey,
        gatewayUrl: '',
        entryId,
        timestampMs: now,
        data: JSON.stringify(entry),
      })
      .onConflictDoNothing()
      .run()
    return true
  } catch (err) {
    // Never silent: a failing insert here means the conversation is invisibly
    // ephemeral again, which is the exact bug this module exists to close.
    log.warn({ err, sessionKey: input.sessionKey }, 'direct-chat entry insert failed')
    return false
  }
}
