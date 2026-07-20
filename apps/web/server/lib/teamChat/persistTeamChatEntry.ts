// The single team-chat transcript writer — the convergence point that makes a
// server-orchestrated cascade render in the thin clients with NO code change.
//
// Persists one TranscriptEntry under the team-scoped session key
// `agent:<agentId>:team:<teamId>` — the exact key `/api/chat-history` +
// GroupChatPanel already read. Every server-side chat source converges here: the
// user message at ingest (role:user), the `narrate` board→chat reflections
// (role:system / kind:meta), and each agent's terminal turn text via
// `serverDeliver.persistTurn` (role:assistant).
//
// Two convergence guarantees this writer owns:
//  • Write-time control-token drop — assistant turns whose entire body is a
//    broken-shape control token (__skipped__ / NO_REPLY / a short refusal) are
//    never persisted, so a thin client that doesn't run the render-time filter
//    (npm/mobile) still shows a clean transcript. The render gate stays as
//    defense-in-depth. The drop is assistant-role-only (mirrors the render gate):
//    a `[Task Update]` meta and a user message starting with "No problem" pass.
//  • Idempotency via `entry_id` (ON CONFLICT DO NOTHING) — a caller may pass a
//    stable `entryId` so a re-drive of the same logical turn doesn't duplicate;
//    omitted, a fresh uuid makes every call a distinct row.

import { randomUUID } from 'node:crypto'

import { chatMessages, type ClawbooDb } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import type { TranscriptEntry, TranscriptEntryKind, TranscriptEntryRole } from '@clawboo/protocol'
import { buildTeamSessionKey, shouldDropAssistantTurn } from '@clawboo/team-orchestration'

const log = createLogger('team-chat-persist')

// Process-local strictly-increasing tiebreaker for same-millisecond entries (the
// merged client sort is timestampMs then sequenceKey). Mirrors the browser's
// lib/sequenceKey.ts; a later pass may replace it with a durable server `seq` column.
let seqCounter = 0
function nextServerSeq(): number {
  return ++seqCounter
}

export interface PersistTeamChatEntryInput {
  teamId: string
  agentId: string
  text: string
  role: TranscriptEntryRole
  kind: TranscriptEntryKind
  runId?: string | null
  /** Stable id for idempotency across a logical re-drive (ON CONFLICT DO NOTHING).
   *  Omitted → a fresh uuid, so each call is a distinct row. */
  entryId?: string
}

/** Build + insert one team-chat TranscriptEntry. Best-effort (chat persistence is
 *  observability, never the orchestration spine). Idempotent via the unique
 *  `entry_id` (ON CONFLICT DO NOTHING), like the chat-history POST. Assistant turns
 *  whose entire body is a broken-shape control token are dropped at write time.
 *
 *  Returns whether a row was actually written (true also on the idempotent
 *  conflict no-op — the entry IS in the transcript either way). `false` means the
 *  entry never reached the transcript (empty / control-token drop / insert error) —
 *  serverDeliver uses that to publish a CLEARING delta so a streamed turn whose
 *  commit never lands doesn't leave a lingering StreamingCard that later vanishes. */
export function persistTeamChatEntry(db: ClawbooDb, input: PersistTeamChatEntryInput): boolean {
  if (!input.text.trim()) return false
  // Write-time drop (assistant-role only, mirroring the render gate): a control
  // token (__skipped__ / NO_REPLY / a short refusal) never reaches the transcript,
  // so a thin client that skips the render filter still shows a clean chat. Meta
  // ([Task Update]) and user entries pass through untouched.
  if (input.role === 'assistant' && shouldDropAssistantTurn(input.text)) return false
  const sessionKey = buildTeamSessionKey(input.agentId, input.teamId)
  const now = Date.now()
  const entry: TranscriptEntry = {
    entryId: input.entryId ?? randomUUID(),
    role: input.role,
    kind: input.kind,
    text: input.text,
    sessionKey,
    runId: input.runId ?? null,
    source: 'local-send',
    timestampMs: now,
    sequenceKey: nextServerSeq(),
    confirmed: true,
    fingerprint: randomUUID(),
  }
  try {
    db.insert(chatMessages)
      .values({
        sessionKey,
        gatewayUrl: '',
        entryId: entry.entryId,
        timestampMs: now,
        data: JSON.stringify(entry),
      })
      .onConflictDoNothing()
      .run()
    return true
  } catch (err) {
    // Best-effort — chat persistence must never break orchestration — but NEVER
    // silent: a failing insert here means the whole team transcript is invisibly
    // ephemeral (replies render from the live delta bus, then vanish on reload).
    log.warn({ err, sessionKey }, 'team-chat entry insert failed — turn not persisted')
    return false
  }
}
