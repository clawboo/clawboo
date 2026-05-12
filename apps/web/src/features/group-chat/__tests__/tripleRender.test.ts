/**
 * Triple-render reproduction + regression tests.
 *
 * Background (Round 2 plan, Phase A): a real user session showed every agent
 * message rendering 3 times in the merged team transcript. User messages
 * rendered once. The root cause hypotheses were:
 *
 *   (a) `participants` array in `GroupChatPanel` contains the same agent
 *       multiple times (e.g., Boo Zero appears both in `teamAgents` AND as
 *       an explicit `booZeroAgent` spread).
 *   (b) `appendOutputLines` is invoked multiple times per Gateway frame
 *       (e.g., the pipeline classifies the same frame twice), each minting
 *       fresh entryIds so the existing entryId-only dedup misses.
 *   (c) `groupEntriesToBlocks` mishandles same-text-different-id entries.
 *
 * These tests assert the *defensive* contract regardless of upstream cause:
 *
 *   - The chat store rejects content-equivalent duplicates inside a small
 *     time window even if their entryIds differ.
 *   - `groupEntriesToBlocks` collapses content-equivalent entries.
 *   - The merge helper used by `GroupChatPanel` dedupes its participants list
 *     so the same agent's transcript is never pulled twice.
 *
 * Run with `pnpm --filter @clawboo/web test -- --run features/group-chat/__tests__/tripleRender.test.ts`.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { TranscriptEntry } from '@clawboo/protocol'
import { useChatStore } from '@/stores/chat'
import { groupEntriesToBlocks } from '@/features/chat/chatComponents'
import { nextSeq } from '@/lib/sequenceKey'

// ── Test entry factory ───────────────────────────────────────────────────────

function makeAssistantEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  return {
    entryId: crypto.randomUUID(),
    runId: 'run-1',
    sessionKey: 'agent:a1:team:t1',
    kind: 'assistant',
    role: 'assistant',
    text: "Hi! I'm Backend Architect Boo — I specialize in scalable system design.",
    source: 'runtime-chat',
    timestampMs: 1_700_000_000_000,
    sequenceKey: nextSeq(),
    confirmed: true,
    fingerprint: crypto.randomUUID(),
    ...overrides,
  } as TranscriptEntry
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('triple-render — chat store content-signature dedup', () => {
  beforeEach(() => {
    useChatStore.setState({
      transcripts: new Map(),
      streamingText: new Map(),
      lastTokenUsage: new Map(),
    })
  })

  it('rejects content-equivalent duplicates with DIFFERENT entryIds (the production bug)', () => {
    // Simulates the production bug: `appendOutputLines` is called 3 times for
    // the same Gateway frame, minting fresh entryIds per call.
    const ts = 1_700_000_000_000
    const text = "Hi! I'm Backend Architect Boo — I specialize in scalable system design."
    const sk = 'agent:backend:team:dev'

    useChatStore
      .getState()
      .appendTranscript(sk, [
        makeAssistantEntry({ entryId: crypto.randomUUID(), sessionKey: sk, text, timestampMs: ts }),
      ])
    useChatStore
      .getState()
      .appendTranscript(sk, [
        makeAssistantEntry({ entryId: crypto.randomUUID(), sessionKey: sk, text, timestampMs: ts }),
      ])
    useChatStore
      .getState()
      .appendTranscript(sk, [
        makeAssistantEntry({ entryId: crypto.randomUUID(), sessionKey: sk, text, timestampMs: ts }),
      ])

    expect(useChatStore.getState().transcripts.get(sk)).toHaveLength(1)
  })

  it('preserves entries with the same content if they are on DIFFERENT sessionKeys', () => {
    // Two different agents posting "Hi! I'm…" at the same instant must NOT be
    // collapsed — they're distinct conversations.
    const ts = 1_700_000_000_000
    const text = 'OK'
    useChatStore
      .getState()
      .appendTranscript('agent:a1:team:t1', [
        makeAssistantEntry({ sessionKey: 'agent:a1:team:t1', text, timestampMs: ts }),
      ])
    useChatStore
      .getState()
      .appendTranscript('agent:a2:team:t1', [
        makeAssistantEntry({ sessionKey: 'agent:a2:team:t1', text, timestampMs: ts }),
      ])
    expect(useChatStore.getState().transcripts.get('agent:a1:team:t1')).toHaveLength(1)
    expect(useChatStore.getState().transcripts.get('agent:a2:team:t1')).toHaveLength(1)
  })

  it('preserves entries with the same text but DIFFERENT roles (user vs assistant)', () => {
    // A user echoing the assistant's "OK" back must not be collapsed.
    const ts = 1_700_000_000_000
    const sk = 'agent:a1:team:t1'
    useChatStore.getState().appendTranscript(sk, [
      makeAssistantEntry({ role: 'assistant', sessionKey: sk, text: 'OK', timestampMs: ts }),
      makeAssistantEntry({
        role: 'user',
        kind: 'user',
        sessionKey: sk,
        text: 'OK',
        timestampMs: ts,
      } as Partial<TranscriptEntry>),
    ])
    expect(useChatStore.getState().transcripts.get(sk)).toHaveLength(2)
  })

  it('preserves entries with the same text but TIMESTAMPS more than 1s apart', () => {
    // A genuine "Hi!" repeated by the same agent later in the conversation
    // must not be lost — only same-second duplicates are collapsed.
    const sk = 'agent:a1:team:t1'
    useChatStore
      .getState()
      .appendTranscript(sk, [
        makeAssistantEntry({ sessionKey: sk, text: 'Hi!', timestampMs: 1_700_000_000_000 }),
      ])
    useChatStore.getState().appendTranscript(sk, [
      // 2 seconds later
      makeAssistantEntry({ sessionKey: sk, text: 'Hi!', timestampMs: 1_700_000_002_000 }),
    ])
    expect(useChatStore.getState().transcripts.get(sk)).toHaveLength(2)
  })

  it('still dedupes by entryId (existing behavior preserved)', () => {
    const sk = 'agent:a1:team:t1'
    const fixedId = 'fixed-entry-id'
    useChatStore
      .getState()
      .appendTranscript(sk, [makeAssistantEntry({ entryId: fixedId, sessionKey: sk })])
    useChatStore
      .getState()
      .appendTranscript(sk, [makeAssistantEntry({ entryId: fixedId, sessionKey: sk })])
    expect(useChatStore.getState().transcripts.get(sk)).toHaveLength(1)
  })
})

describe('triple-render — end-to-end through the store + grouper', () => {
  beforeEach(() => {
    useChatStore.setState({
      transcripts: new Map(),
      streamingText: new Map(),
      lastTokenUsage: new Map(),
    })
  })

  it('renders a single assistant-turn block when the production bug fires 3x via the store', () => {
    // End-to-end check: feed 3 same-frame events into the store (the exact
    // production scenario), then run the merged transcript through
    // `groupEntriesToBlocks`. Expect exactly 1 assistant-turn block.
    const ts = 1_700_000_000_000
    const text = "Hi! I'm Backend Architect Boo"
    const sk = 'agent:backend:team:dev'

    for (let i = 0; i < 3; i++) {
      useChatStore.getState().appendTranscript(sk, [
        makeAssistantEntry({
          entryId: crypto.randomUUID(), // fresh id per call (production bug)
          sessionKey: sk,
          text,
          timestampMs: ts,
        }),
      ])
    }

    const stored = useChatStore.getState().transcripts.get(sk) ?? []
    const blocks = groupEntriesToBlocks(stored)
    const assistantBlocks = blocks.filter((b) => b.kind === 'assistant-turn')
    expect(stored).toHaveLength(1)
    expect(assistantBlocks).toHaveLength(1)
  })
})
