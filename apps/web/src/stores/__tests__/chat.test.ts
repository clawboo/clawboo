import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../chat'
import type { TranscriptEntry } from '@clawboo/protocol'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Factory uses the entryId as part of the text + slightly-staggered timestamps
 * so distinct entries are content-distinct too. The store now dedupes by
 * content signature in addition to entryId (Round 2, Phase A) — tests that
 * relied on multiple `entryId`s with identical text + timestamp were
 * exercising a degenerate case that doesn't occur in production.
 */
let nextTs = 1_700_000_000_000
function makeEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  const id = overrides.entryId ?? `e${nextTs}`
  return {
    entryId: id,
    kind: 'assistant',
    source: 'runtime',
    text: `Hello world ${id}`,
    timestamp: nextTs++,
    timestampMs: nextTs,
    ...overrides,
  } as TranscriptEntry
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('useChatStore', () => {
  beforeEach(() => {
    useChatStore.setState({
      transcripts: new Map(),
      streamingText: new Map(),
      streamStartedAt: new Map(),
      lastTokenUsage: new Map(),
    })
  })

  it('starts with empty maps', () => {
    const state = useChatStore.getState()
    expect(state.transcripts.size).toBe(0)
    expect(state.streamingText.size).toBe(0)
    expect(state.streamStartedAt.size).toBe(0)
    expect(state.lastTokenUsage.size).toBe(0)
  })

  describe('appendTranscript', () => {
    it('adds entries for a session', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      const entries = useChatStore.getState().transcripts.get('s1')
      expect(entries).toHaveLength(1)
      expect(entries![0].entryId).toBe('e1')
    })

    it('deduplicates by entryId', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      expect(useChatStore.getState().transcripts.get('s1')).toHaveLength(1)
    })

    it('appends fresh entries alongside existing', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e2' })])
      expect(useChatStore.getState().transcripts.get('s1')).toHaveLength(2)
    })

    it('caps at 500 entries', () => {
      const batch = Array.from({ length: 510 }, (_, i) => makeEntry({ entryId: `e${i}` }))
      useChatStore.getState().appendTranscript('s1', batch)
      const entries = useChatStore.getState().transcripts.get('s1')
      expect(entries).toHaveLength(500)
      // Should keep the last 500 (e10–e509)
      expect(entries![0].entryId).toBe('e10')
      expect(entries![499].entryId).toBe('e509')
    })

    it('returns same state ref if all entries are duplicates', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      const before = useChatStore.getState()
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      const after = useChatStore.getState()
      // Zustand should return the same state object reference when nothing changes
      expect(before.transcripts).toBe(after.transcripts)
    })

    it('does not affect other sessions', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      useChatStore.getState().appendTranscript('s2', [makeEntry({ entryId: 'e2' })])
      expect(useChatStore.getState().transcripts.get('s1')).toHaveLength(1)
      expect(useChatStore.getState().transcripts.get('s2')).toHaveLength(1)
    })

    // Regression: an OpenClaw team turn is written by TWO writers — the server
    // orchestrator (source 'local-send', runId null) AND the browser Gateway
    // observer (source 'runtime-chat', with runId) — landing in DIFFERENT
    // 1-second buckets (streamStart vs Date.now()). A LONG byte-identical turn in
    // a team session must dedup timestamp-independently so the user sees ONE copy.
    it('dedups a cross-writer duplicate of a long team turn (>1s apart)', () => {
      const teamKey = 'agent:main:team:t1'
      const longText = 'I am aware you have a whole Boo squad here and I will coordinate them for you across the sprint.'
      // Browser copy: runtime-chat, has a runId, timestamp T.
      useChatStore.getState().appendTranscript(teamKey, [
        makeEntry({ entryId: 'browser-1', source: 'runtime-chat', runId: 'run-1', text: longText, timestampMs: 1_700_000_000_000 }),
      ])
      // Server copy: local-send, runId null, timestamp T+5s (a different bucket).
      useChatStore.getState().appendTranscript(teamKey, [
        makeEntry({ entryId: 'server-1', source: 'local-send', runId: null, text: longText, timestampMs: 1_700_000_005_000 }),
      ])
      expect(useChatStore.getState().transcripts.get(teamKey)).toHaveLength(1)
    })

    it('does NOT collapse a short repeated team ack (keeps the 1-second bucket)', () => {
      const teamKey = 'agent:main:team:t1'
      useChatStore.getState().appendTranscript(teamKey, [
        makeEntry({ entryId: 'a', text: 'On it.', timestampMs: 1_700_000_000_000 }),
      ])
      useChatStore.getState().appendTranscript(teamKey, [
        makeEntry({ entryId: 'b', text: 'On it.', timestampMs: 1_700_000_030_000 }),
      ])
      // Short (<80 char) verbatim re-utterance >1s apart is a legitimate repeat.
      expect(useChatStore.getState().transcripts.get(teamKey)).toHaveLength(2)
    })

    it('does NOT collapse a long identical 1:1 message >1s apart (non-team session)', () => {
      const soloKey = 'agent:x:main'
      const longText = 'This is a long message that a user might legitimately paste twice into a one-on-one chat over time.'
      useChatStore.getState().appendTranscript(soloKey, [
        makeEntry({ entryId: 'x1', text: longText, timestampMs: 1_700_000_000_000 }),
      ])
      useChatStore.getState().appendTranscript(soloKey, [
        makeEntry({ entryId: 'x2', text: longText, timestampMs: 1_700_000_005_000 }),
      ])
      expect(useChatStore.getState().transcripts.get(soloKey)).toHaveLength(2)
    })
  })

  describe('setStreamingText', () => {
    it('stores text for a session', () => {
      useChatStore.getState().setStreamingText('s1', 'thinking...')
      expect(useChatStore.getState().streamingText.get('s1')).toBe('thinking...')
    })

    it('clears with null', () => {
      useChatStore.getState().setStreamingText('s1', 'thinking...')
      useChatStore.getState().setStreamingText('s1', null)
      expect(useChatStore.getState().streamingText.has('s1')).toBe(false)
    })

    it('overwrites previous text', () => {
      useChatStore.getState().setStreamingText('s1', 'first')
      useChatStore.getState().setStreamingText('s1', 'second')
      expect(useChatStore.getState().streamingText.get('s1')).toBe('second')
    })
  })

  describe('clearTranscript', () => {
    it('removes transcript and streaming for a session', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      useChatStore.getState().setStreamingText('s1', 'hello')
      useChatStore.getState().clearTranscript('s1')
      expect(useChatStore.getState().transcripts.has('s1')).toBe(false)
      expect(useChatStore.getState().streamingText.has('s1')).toBe(false)
    })

    it('does not affect other sessions', () => {
      useChatStore.getState().appendTranscript('s1', [makeEntry({ entryId: 'e1' })])
      useChatStore.getState().appendTranscript('s2', [makeEntry({ entryId: 'e2' })])
      useChatStore.getState().setStreamingText('s2', 'hello')
      useChatStore.getState().clearTranscript('s1')
      expect(useChatStore.getState().transcripts.get('s2')).toHaveLength(1)
      expect(useChatStore.getState().streamingText.get('s2')).toBe('hello')
    })

    it('does not affect lastTokenUsage', () => {
      useChatStore.getState().setLastTokenUsage('r1', 100, 200)
      useChatStore.getState().clearTranscript('s1')
      expect(useChatStore.getState().lastTokenUsage.get('r1')).toEqual({
        inputTokens: 100,
        outputTokens: 200,
      })
    })
  })

  describe('setLastTokenUsage', () => {
    it('stores usage for a runId', () => {
      useChatStore.getState().setLastTokenUsage('r1', 100, 200)
      expect(useChatStore.getState().lastTokenUsage.get('r1')).toEqual({
        inputTokens: 100,
        outputTokens: 200,
      })
    })

    it('overwrites previous usage', () => {
      useChatStore.getState().setLastTokenUsage('r1', 100, 200)
      useChatStore.getState().setLastTokenUsage('r1', 300, 400)
      expect(useChatStore.getState().lastTokenUsage.get('r1')).toEqual({
        inputTokens: 300,
        outputTokens: 400,
      })
    })

    it('stores multiple runIds independently', () => {
      useChatStore.getState().setLastTokenUsage('r1', 100, 200)
      useChatStore.getState().setLastTokenUsage('r2', 300, 400)
      expect(useChatStore.getState().lastTokenUsage.size).toBe(2)
      expect(useChatStore.getState().lastTokenUsage.get('r1')!.inputTokens).toBe(100)
      expect(useChatStore.getState().lastTokenUsage.get('r2')!.inputTokens).toBe(300)
    })
  })

  // Round 5: stream-start timestamps moved from `lib/streamStartTracker.ts`
  // into the chat store so renderers can subscribe reactively. The store
  // anchors live `StreamingCard`s at their chronological position; on commit
  // the entry's `timestampMs` reuses the same value so there's zero visible
  // re-arrangement when the stream lands.
  describe('setStreamStart / clearStreamStart', () => {
    it('captures the first stream-start timestamp for a session', () => {
      useChatStore.getState().setStreamStart('agent:a1:main', 1000)
      expect(useChatStore.getState().streamStartedAt.get('agent:a1:main')).toBe(1000)
    })

    it('first capture wins — subsequent setStreamStart calls do not reset', () => {
      useChatStore.getState().setStreamStart('agent:a1:main', 1000)
      useChatStore.getState().setStreamStart('agent:a1:main', 1500)
      useChatStore.getState().setStreamStart('agent:a1:main', 2000)
      expect(useChatStore.getState().streamStartedAt.get('agent:a1:main')).toBe(1000)
    })

    it('clearStreamStart removes the anchor', () => {
      useChatStore.getState().setStreamStart('agent:a1:main', 1000)
      useChatStore.getState().clearStreamStart('agent:a1:main')
      expect(useChatStore.getState().streamStartedAt.has('agent:a1:main')).toBe(false)
    })

    it('the next stream after clear re-anchors from scratch', () => {
      useChatStore.getState().setStreamStart('agent:a1:main', 1000)
      useChatStore.getState().clearStreamStart('agent:a1:main')
      useChatStore.getState().setStreamStart('agent:a1:main', 5000)
      expect(useChatStore.getState().streamStartedAt.get('agent:a1:main')).toBe(5000)
    })

    it('clearStreamStart is a no-op when the session has no anchor', () => {
      const before = useChatStore.getState().streamStartedAt
      useChatStore.getState().clearStreamStart('agent:nonexistent:main')
      // Reference stays identical when nothing changed (Round 5 contract).
      expect(useChatStore.getState().streamStartedAt).toBe(before)
    })

    it('isolates sessions — capturing one does not leak into another', () => {
      useChatStore.getState().setStreamStart('agent:leader:team:t1', 1000)
      useChatStore.getState().setStreamStart('agent:specialist:team:t1', 1500)
      expect(useChatStore.getState().streamStartedAt.get('agent:leader:team:t1')).toBe(1000)
      expect(useChatStore.getState().streamStartedAt.get('agent:specialist:team:t1')).toBe(1500)
    })

    it("clearTranscript also wipes the session's stream-start anchor", () => {
      useChatStore.getState().setStreamStart('agent:a1:main', 1000)
      useChatStore.getState().clearTranscript('agent:a1:main')
      expect(useChatStore.getState().streamStartedAt.has('agent:a1:main')).toBe(false)
    })

    it('emits a new state reference (renderers re-subscribe correctly)', () => {
      const before = useChatStore.getState().streamStartedAt
      useChatStore.getState().setStreamStart('agent:a1:main', 1000)
      const after = useChatStore.getState().streamStartedAt
      expect(after).not.toBe(before)
    })
  })
})
