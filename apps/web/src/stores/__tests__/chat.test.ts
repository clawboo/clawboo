import { describe, it, expect, beforeEach } from 'vitest'
import { useChatStore } from '../chat'
import type { TranscriptEntry } from '@clawboo/protocol'

// ── Helpers ──────────────────────────────────────────────────────────────────

/**
 * Fully-populated `TranscriptEntry` factory — no casts, every field a real
 * member of its type. Distinct entries are content-distinct (the entryId is
 * embedded in the text) and land on distinct timestamps, because the store's
 * layer-2 dedup keys on `kind|role|timestampMs|text`.
 */
let nextTs = 1_700_000_000_000
function makeEntry(overrides: Partial<TranscriptEntry> = {}): TranscriptEntry {
  const id = overrides.entryId ?? `e${nextTs}`
  const ts = nextTs++
  return {
    entryId: id,
    role: 'assistant',
    kind: 'assistant',
    text: `Hello world ${id}`,
    sessionKey: 'agent:a1:main',
    runId: null,
    source: 'runtime-chat',
    timestampMs: ts,
    sequenceKey: ts,
    confirmed: true,
    fingerprint: `fp-${id}`,
    ...overrides,
  }
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

    it('caps at 2000 entries, keeping the most recent', () => {
      // An ARRAY bound, not a rendering one: `useRenderWindow` already limits the
      // DOM. It was 500 while starting fresh emptied the chat; a conversation that
      // is never cleared and can be paged backwards needs room for several pages of
      // scrollback to survive the next reply landing.
      const batch = Array.from({ length: 2010 }, (_, i) => makeEntry({ entryId: `e${i}` }))
      useChatStore.getState().appendTranscript('s1', batch)
      const entries = useChatStore.getState().transcripts.get('s1')
      expect(entries).toHaveLength(2000)
      expect(entries![0]!.entryId).toBe('e10')
      expect(entries![1999]!.entryId).toBe('e2009')
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

    // Layer 2 collapses the SAME frame appended twice: byte-identical text on
    // the same wall-clock instant, with fresh entryIds (each
    // `appendOutputLines` call mints one via `crypto.randomUUID()`).
    it('collapses a same-tick duplicate batch (identical timestampMs, fresh entryIds)', () => {
      const sk = 'agent:a1:main'
      const ts = 1_700_000_000_000
      for (const entryId of ['copy-1', 'copy-2', 'copy-3']) {
        useChatStore
          .getState()
          .appendTranscript(sk, [makeEntry({ entryId, text: 'Same frame', timestampMs: ts })])
      }
      expect(useChatStore.getState().transcripts.get(sk)).toHaveLength(1)
    })

    // Replaces the old "cross-writer long team turn" case. That duplicate is no
    // longer producible: `appendOutputLines` early-returns for team session keys
    // (`features/connection/useGatewayEvents.ts`), so the browser Gateway
    // observer never double-writes a turn the server orchestrator persisted. The
    // timestamp-independent rule that used to collapse it was eating genuine
    // re-utterances (#71), so the contract is now the inverse.
    it('preserves a long verbatim re-utterance in a team session', () => {
      const teamKey = 'agent:main:team:t1'
      const longText =
        'I am aware you have a whole Boo squad here and I will coordinate them for you across the sprint.'
      useChatStore
        .getState()
        .appendTranscript(teamKey, [
          makeEntry({ entryId: 'turn-1', text: longText, timestampMs: 1_700_000_000_000 }),
        ])
      useChatStore
        .getState()
        .appendTranscript(teamKey, [
          makeEntry({ entryId: 'turn-2', text: longText, timestampMs: 1_700_000_005_000 }),
        ])
      expect(useChatStore.getState().transcripts.get(teamKey)).toHaveLength(2)
    })

    // Layer 2 only scans the tail (DEDUP_SCAN_WINDOW), because the signature
    // carries full text and re-hashing 500 markdown answers per commit would
    // scale with transcript bytes. A duplicate frame always lands adjacent to
    // its twin, so the bound is safe — this pins it so nobody silently widens it.
    it('does not scan beyond the dedup window', () => {
      const sk = 'agent:a1:main'
      const ts = 1_700_000_000_000
      useChatStore
        .getState()
        .appendTranscript(sk, [makeEntry({ entryId: 'far-1', text: 'echo', timestampMs: ts })])
      const filler = Array.from({ length: 60 }, (_, i) => makeEntry({ entryId: `filler-${i}` }))
      useChatStore.getState().appendTranscript(sk, filler)
      useChatStore
        .getState()
        .appendTranscript(sk, [makeEntry({ entryId: 'far-2', text: 'echo', timestampMs: ts })])
      const entries = useChatStore.getState().transcripts.get(sk)!
      expect(entries.filter((e) => e.text === 'echo')).toHaveLength(2)
    })

    it('does NOT collapse a short repeated team ack', () => {
      const teamKey = 'agent:main:team:t1'
      useChatStore
        .getState()
        .appendTranscript(teamKey, [
          makeEntry({ entryId: 'a', text: 'On it.', timestampMs: 1_700_000_000_000 }),
        ])
      useChatStore
        .getState()
        .appendTranscript(teamKey, [
          makeEntry({ entryId: 'b', text: 'On it.', timestampMs: 1_700_000_030_000 }),
        ])
      // A verbatim re-utterance later in the conversation is a legitimate repeat.
      expect(useChatStore.getState().transcripts.get(teamKey)).toHaveLength(2)
    })

    // #71: the old 1-second bucket collapsed these. Two agent acks 300 ms apart
    // are distinct messages, not a duplicated frame.
    it('does NOT collapse two identical short messages inside the same second', () => {
      const teamKey = 'agent:main:team:t1'
      useChatStore
        .getState()
        .appendTranscript(teamKey, [
          makeEntry({ entryId: 'ack-1', text: 'On it.', timestampMs: 1_700_000_000_100 }),
        ])
      useChatStore
        .getState()
        .appendTranscript(teamKey, [
          makeEntry({ entryId: 'ack-2', text: 'On it.', timestampMs: 1_700_000_000_400 }),
        ])
      expect(useChatStore.getState().transcripts.get(teamKey)).toHaveLength(2)
    })

    // The old key truncated text at 160 chars, so two long answers that only
    // diverged later collapsed into one.
    it('does NOT collapse two messages that share a 160-character prefix', () => {
      const sk = 'agent:a1:main'
      const prefix = 'x'.repeat(200)
      useChatStore
        .getState()
        .appendTranscript(sk, [
          makeEntry({ entryId: 'p1', text: `${prefix}FIRST`, timestampMs: 1_700_000_000_000 }),
        ])
      useChatStore
        .getState()
        .appendTranscript(sk, [
          makeEntry({ entryId: 'p2', text: `${prefix}SECOND`, timestampMs: 1_700_000_000_000 }),
        ])
      expect(useChatStore.getState().transcripts.get(sk)).toHaveLength(2)
    })

    // Layer 2 fails OPEN on an entry it cannot fingerprint. `timestampMs` is
    // `number | null` on the type, and a null used to stringify to '' — so two
    // legitimately distinct untimestamped entries sharing kind/role/text
    // collapsed to one. No producer emits null today; the type allows it.
    it('does NOT collapse two identical entries with a null timestamp', () => {
      const sk = 'agent:a1:main'
      useChatStore
        .getState()
        .appendTranscript(sk, [makeEntry({ entryId: 'n1', text: 'same', timestampMs: null })])
      useChatStore
        .getState()
        .appendTranscript(sk, [makeEntry({ entryId: 'n2', text: 'same', timestampMs: null })])
      expect(useChatStore.getState().transcripts.get(sk)).toHaveLength(2)
    })

    it('does NOT collapse a long identical 1:1 message sent twice over time', () => {
      const soloKey = 'agent:x:main'
      const longText =
        'This is a long message that a user might legitimately paste twice into a one-on-one chat over time.'
      useChatStore
        .getState()
        .appendTranscript(soloKey, [
          makeEntry({ entryId: 'x1', text: longText, timestampMs: 1_700_000_000_000 }),
        ])
      useChatStore
        .getState()
        .appendTranscript(soloKey, [
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

describe('prependTranscript', () => {
  beforeEach(() => {
    useChatStore.setState({
      transcripts: new Map(),
      streamingText: new Map(),
      streamStartedAt: new Map(),
      lastTokenUsage: new Map(),
    })
  })

  // Scrolling back through a conversation that is never cleared. `appendTranscript`
  // cannot serve this: it appends and then trims the FRONT, which is exactly where a
  // page of history lands, so history routed through it would be placed after the
  // new messages and then dropped.
  const store = () => useChatStore.getState()
  const texts = (key: string) => (store().transcripts.get(key) ?? []).map((e) => e.text)

  it('puts older entries in front of what is already loaded', () => {
    const recent = makeEntry({ entryId: 'recent', text: 'newer' })
    const older = makeEntry({ entryId: 'older', text: 'older' })
    store().appendTranscript('k', [recent])
    store().prependTranscript('k', [older])
    expect(texts('k')).toEqual(['older', 'newer'])
  })

  it('does not re-add a page that is already loaded', () => {
    const e = makeEntry({ entryId: 'dupe', text: 'once' })
    store().appendTranscript('k', [e])
    store().prependTranscript('k', [e])
    expect(texts('k')).toEqual(['once'])
  })

  it('keeps two genuinely identical old messages', () => {
    // Content dedup exists to collapse a commit batch appended twice in one tick. A
    // page of history is neither, and a person who said the same thing twice must
    // see it twice when they scroll back to it.
    const a = makeEntry({ entryId: 'a', text: 'ok', timestampMs: 5, sequenceKey: 5 })
    const b = makeEntry({ entryId: 'b', text: 'ok', timestampMs: 5, sequenceKey: 5 })
    store().prependTranscript('k', [a, b])
    expect(texts('k')).toEqual(['ok', 'ok'])
  })

  it('is a no-op for an empty page', () => {
    store().appendTranscript('k', [makeEntry({ entryId: 'only' })])
    const before = store().transcripts
    store().prependTranscript('k', [])
    expect(store().transcripts).toBe(before)
  })

  it('survives a live message landing on top of paged-in history', () => {
    // The cap used to be 500 and trimmed the front, so the next reply threw away the
    // history the person had just pulled in.
    const older = Array.from({ length: 600 }, (_, i) =>
      makeEntry({ entryId: `old-${i}`, text: `old-${i}` }),
    )
    store().prependTranscript('k', older)
    store().appendTranscript('k', [makeEntry({ entryId: 'live', text: 'live' })])
    const kept = texts('k')
    expect(kept).toContain('old-0')
    expect(kept[kept.length - 1]).toBe('live')
  })
})
