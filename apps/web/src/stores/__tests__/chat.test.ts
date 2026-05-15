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

  // Round 7: setClawbooDispatch + clearClawbooDispatches. The store records
  // every `chat.send` Clawboo fires to a team specialist so the renderer
  // can surface those events as DelegationCards (Path 3 in
  // `buildDelegationLinkages`), independent of LLM emission format.
  describe('setClawbooDispatch / clearClawbooDispatches', () => {
    beforeEach(() => {
      useChatStore.setState({
        clawbooDispatches: new Map(),
      })
    })

    function makeDispatch(overrides: Partial<import('../chat').ClawbooDispatch> = {}) {
      return {
        dispatchId: 'd-' + Math.random().toString(36).slice(2, 9),
        sourceEntryId: 'src-1',
        sourceAgentId: 'bz',
        targetAgentId: 'eng',
        targetAgentName: 'Engineer Boo',
        taskBody: 'do the thing',
        origin: 'dispatch-delegation' as const,
        sequenceKey: 1,
        timestampMs: 1_700_000_000_000,
        teamId: 't1',
        ...overrides,
      }
    }

    it('stores a dispatch under the `${teamId}:${sourceEntryId}` key', () => {
      const dispatch = makeDispatch()
      useChatStore.getState().setClawbooDispatch(dispatch)
      const stored = useChatStore.getState().clawbooDispatches.get('t1:src-1')
      expect(stored).toHaveLength(1)
      expect(stored![0]).toBe(dispatch)
    })

    it('accumulates multiple dispatches under the same source entry', () => {
      useChatStore
        .getState()
        .setClawbooDispatch(makeDispatch({ dispatchId: 'd-a', targetAgentId: 'eng' }))
      useChatStore
        .getState()
        .setClawbooDispatch(makeDispatch({ dispatchId: 'd-b', targetAgentId: 'des' }))
      useChatStore
        .getState()
        .setClawbooDispatch(makeDispatch({ dispatchId: 'd-c', targetAgentId: 'his' }))
      const stored = useChatStore.getState().clawbooDispatches.get('t1:src-1')
      expect(stored).toHaveLength(3)
      expect(stored!.map((d) => d.dispatchId)).toEqual(['d-a', 'd-b', 'd-c'])
    })

    it('dedups by dispatchId — a retry with the same id is a no-op', () => {
      const dispatch = makeDispatch()
      useChatStore.getState().setClawbooDispatch(dispatch)
      useChatStore.getState().setClawbooDispatch(dispatch)
      useChatStore.getState().setClawbooDispatch(dispatch)
      expect(useChatStore.getState().clawbooDispatches.get('t1:src-1')).toHaveLength(1)
    })

    it('clearClawbooDispatches(teamId) wipes only that team — other teams untouched', () => {
      useChatStore.getState().setClawbooDispatch(makeDispatch({ teamId: 't1', sourceEntryId: 'a' }))
      useChatStore.getState().setClawbooDispatch(makeDispatch({ teamId: 't1', sourceEntryId: 'b' }))
      useChatStore.getState().setClawbooDispatch(makeDispatch({ teamId: 't2', sourceEntryId: 'a' }))
      useChatStore.getState().clearClawbooDispatches('t1')
      expect(useChatStore.getState().clawbooDispatches.has('t1:a')).toBe(false)
      expect(useChatStore.getState().clawbooDispatches.has('t1:b')).toBe(false)
      // t2 still there.
      expect(useChatStore.getState().clawbooDispatches.has('t2:a')).toBe(true)
    })
  })
})
