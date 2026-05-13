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
      lastTokenUsage: new Map(),
    })
  })

  it('starts with empty maps', () => {
    const state = useChatStore.getState()
    expect(state.transcripts.size).toBe(0)
    expect(state.streamingText.size).toBe(0)
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
})
