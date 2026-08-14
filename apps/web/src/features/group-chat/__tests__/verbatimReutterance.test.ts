/**
 * #71 — message fidelity: a verbatim re-utterance must survive.
 *
 * The chat store's layer-2 dedup used to key on a 1-second timestamp bucket,
 * and — for long non-user turns in a TEAM session — on no timestamp at all
 * (`'T'`). That collapsed two classes of legitimate message:
 *
 *   • two identical short acks emitted inside the same second, and
 *   • an agent re-posting the same long status later in the conversation.
 *
 * It is now exact-frame identity (`kind|role|timestampMs|text`), so both
 * survive while the same frame appended twice is still collapsed.
 *
 * Scope note: the PRODUCTION-shaped duplicate — the Gateway re-delivering a
 * `chat:final`, whose second copy lands on a DIFFERENT timestamp and runId
 * because `appendOutputLines` reads and clears the stream-start anchor — is
 * stopped upstream and is covered by `packages/events/src/__tests__/handler.test.ts`.
 * This file covers the store's remaining same-tick net. Together they are the
 * issue's fourth acceptance criterion.
 *
 * Assertions run through `groupEntriesToBlocks` as well as the store, because
 * the grouper does no content dedup of its own — two identical entries must
 * produce two blocks, not one.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'

import { groupEntriesToBlocks } from '@/features/chat/chatComponents'
import { useChatStore } from '@/stores/chat'

// ── Helpers ──────────────────────────────────────────────────────────────────

const TEAM_KEY = 'agent:a1:team:t1'

function entry(over: Partial<TranscriptEntry>): TranscriptEntry {
  return {
    entryId: 'e1',
    role: 'assistant',
    kind: 'assistant',
    text: 'hello',
    sessionKey: TEAM_KEY,
    runId: 'r1',
    source: 'runtime-chat',
    timestampMs: 1_700_000_000_000,
    sequenceKey: 1,
    confirmed: true,
    fingerprint: 'f1',
    ...over,
  }
}

function storedBlockCount(sessionKey: string): { entries: number; assistantBlocks: number } {
  const stored = useChatStore.getState().transcripts.get(sessionKey) ?? []
  const blocks = groupEntriesToBlocks(stored)
  return {
    entries: stored.length,
    assistantBlocks: blocks.filter((b) => b.kind === 'assistant-turn').length,
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('verbatim re-utterances survive', () => {
  beforeEach(() => {
    useChatStore.setState({
      transcripts: new Map(),
      streamingText: new Map(),
      streamStartedAt: new Map(),
      lastTokenUsage: new Map(),
    })
  })

  it('keeps two byte-identical SHORT agent messages emitted in the same second', () => {
    // 300 ms apart — the old 1-second bucket put both in the same slot and
    // dropped the second.
    useChatStore
      .getState()
      .appendTranscript(TEAM_KEY, [
        entry({ entryId: 'ack-1', text: 'On it.', timestampMs: 1_700_000_000_100 }),
      ])
    useChatStore
      .getState()
      .appendTranscript(TEAM_KEY, [
        entry({ entryId: 'ack-2', text: 'On it.', timestampMs: 1_700_000_000_400 }),
      ])

    expect(storedBlockCount(TEAM_KEY)).toEqual({ entries: 2, assistantBlocks: 2 })
  })

  it('keeps two byte-identical LONG agent messages in a team session', () => {
    // >80 chars in a team session hit the timestamp-INDEPENDENT `'T'` bucket, so
    // the second copy was dropped no matter how far apart it arrived.
    const longText =
      'Status unchanged: the migration is still running, roughly forty minutes of backfill remain.'
    expect(longText.length).toBeGreaterThan(80)

    useChatStore
      .getState()
      .appendTranscript(TEAM_KEY, [
        entry({ entryId: 'status-1', text: longText, timestampMs: 1_700_000_000_000 }),
      ])
    useChatStore.getState().appendTranscript(TEAM_KEY, [
      entry({
        entryId: 'status-2',
        runId: 'r2',
        text: longText,
        timestampMs: 1_700_000_600_000,
      }),
    ])

    expect(storedBlockCount(TEAM_KEY)).toEqual({ entries: 2, assistantBlocks: 2 })
  })

  it('still collapses a triple-render duplicate of one frame', () => {
    // Three appends of the SAME frame: identical kind/role/text/timestampMs,
    // fresh entryIds (each `appendOutputLines` call mints one).
    const ts = 1_700_000_000_000
    const text = "Hi! I'm Backend Architect Boo"
    for (const entryId of ['dup-1', 'dup-2', 'dup-3']) {
      useChatStore
        .getState()
        .appendTranscript(TEAM_KEY, [entry({ entryId, text, timestampMs: ts })])
    }

    expect(storedBlockCount(TEAM_KEY)).toEqual({ entries: 1, assistantBlocks: 1 })
  })
})
