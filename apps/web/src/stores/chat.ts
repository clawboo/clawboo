import { create } from 'zustand'
import type { TranscriptEntry } from '@clawboo/protocol'

/**
 * How far back layer-2 dedup (see `appendTranscript`) looks. A duplicate frame
 * always lands adjacent to its twin — only the other lines of the same commit
 * batch can separate them — so a bounded tail is enough. It also keeps the cost
 * flat: the signature carries the entry's FULL text, and re-hashing all 500
 * capped entries on every streamed commit would scale with transcript bytes.
 */
const DEDUP_SCAN_WINDOW = 50

// ─── Store ────────────────────────────────────────────────────────────────────
// Keyed by sessionKey so multiple agent conversations are held simultaneously.

interface ChatStore {
  /** Committed transcript entries, keyed by sessionKey. */
  transcripts: Map<string, TranscriptEntry[]>
  /** Live streaming text that hasn't been committed yet, keyed by sessionKey. */
  streamingText: Map<string, string>
  /**
   * Stream-start timestamp per session (ms since epoch). Captured on the
   * FIRST streaming chunk for a session and used by:
   *   1. `useGatewayEvents.appendOutputLines` to anchor the eventual
   *      committed entry's `timestampMs` (so a long-streaming leader sorts
   *      ABOVE fast specialists that wake mid-stream and commit first).
   *   2. The renderer (`GroupChatPanel`, `chatComponents.MessageList`) to
   *      position the live `StreamingCard` at its chronological slot in the
   *      merged timeline — instead of always-at-the-end, which produced the
   *      visible "leader's card jumps from bottom to top" re-arrangement
   *      on commit.
   */
  streamStartedAt: Map<string, number>
  /** Token usage from final chat events, keyed by runId. */
  lastTokenUsage: Map<string, { inputTokens: number; outputTokens: number }>

  /** Append one or more entries to a session's transcript. */
  appendTranscript: (sessionKey: string, entries: TranscriptEntry[]) => void

  /** Set (or clear) the live streaming text for a session. */
  setStreamingText: (sessionKey: string, text: string | null) => void

  /**
   * Capture the first streaming chunk's timestamp. No-op if a stream-start
   * is already recorded for this session (preserves the original anchor
   * across mid-stream patches).
   */
  setStreamStart: (sessionKey: string, ts: number) => void

  /**
   * Clear the stream-start anchor — called at commit time AFTER
   * `appendOutputLines` has read the value so the next streamed turn for
   * the same session re-anchors from scratch.
   */
  clearStreamStart: (sessionKey: string) => void

  /** Wipe all transcript + streaming state for a session. */
  clearTranscript: (sessionKey: string) => void

  /** Store token usage for a completed run. */
  setLastTokenUsage: (runId: string, inputTokens: number, outputTokens: number) => void
}

export const useChatStore = create<ChatStore>((set) => ({
  transcripts: new Map(),
  streamingText: new Map(),
  streamStartedAt: new Map(),
  lastTokenUsage: new Map(),

  appendTranscript: (sessionKey, entries) =>
    set((state) => {
      const next = new Map(state.transcripts)
      const existing = next.get(sessionKey) ?? []

      // Dedup layer 1: entryId (preserves React key stability across re-fetches).
      // Stays GLOBAL — the SSE replay-from-0, the `/api/chat-history` hydration
      // and the optimistic user bubble all reconcile by matching entryIds against
      // the whole transcript.
      const seenIds = new Set(existing.map((e) => e.entryId))

      // Dedup layer 2: EXACT-FRAME IDENTITY. Two entries collapse only when they
      // are byte-identical AND stamped with the same wall-clock instant — i.e.
      // the same commit batch appended twice within one tick. A verbatim
      // re-utterance, however soon after, lands on a different millisecond and
      // survives. Scoping is implicit in `sessionKey` (only entries on the same
      // session are compared).
      //
      // What makes this safe is the upstream guard: the `commitChat` case in
      // `packages/events/src/handler.ts` now drops a replayed `chat:final` whose
      // runId is already in `closedRuns`, so the multi-final duplicate class
      // never reaches this store. Layer 2 is a last-resort net, not the primary
      // defence — if the diagnostic below ever fires, the handler guard missed.
      //
      // Deliberately NOT in the key:
      //   • runId — read from mutable fleet state at mint time
      //     (`useGatewayEvents.ts` `appendOutputLines`). A replayed frame's copy
      //     reads `null` because the first copy's dispatch already cleared it, so
      //     runId ANTI-correlates with duplicate-ness.
      //   • sequenceKey — `nextSeq()` is strictly increasing and unique per
      //     entry by construction, so including it would disable layer 2.
      //   • a team-session carve-out — `appendOutputLines` early-returns for team
      //     session keys, so the cross-writer duplicate that the old
      //     timestamp-independent bucket defended against is no longer
      //     producible. That bucket was collapsing genuine re-utterances (#71).
      //
      // Returns `null` when the entry cannot be fingerprinted precisely, which today
      // means only a missing `timestampMs`. Such an entry is never compared and
      // never recorded, so layer 2 simply does not apply to it — the same
      // fail-OPEN choice the handler's closed-run guard makes for a frame with
      // no runId: showing a duplicate beats dropping a real message. Without
      // this, a `null` timestamp collapses to `''` and two legitimately distinct
      // entries that happen to share kind/role/text would dedup to one.
      //
      // Unreachable from today's producers (every call site stamps a real time,
      // `chat_messages.timestamp_ms` is NOT NULL, and `/api/chat-history`
      // coalesces), but `TranscriptEntry.timestampMs` is `number | null`, so the
      // type permits it and a future producer would hit it silently.
      function frameSig(e: {
        kind?: string
        role?: string
        timestampMs?: number | null
        text?: string
      }): string | null {
        if (e.timestampMs == null) return null
        return `${e.kind ?? ''}|${e.role ?? ''}|${e.timestampMs}|${e.text ?? ''}`
      }
      const seenSigs = new Set<string>()
      for (let i = Math.max(0, existing.length - DEDUP_SCAN_WINDOW); i < existing.length; i++) {
        const sig = frameSig(existing[i]!)
        if (sig !== null) seenSigs.add(sig)
      }

      const fresh: typeof entries = []
      const droppedByContent: { entryId: string; sig: string }[] = []
      for (const e of entries) {
        if (seenIds.has(e.entryId)) continue
        // Each accepted entry adds its own signature, so dedup WITHIN the
        // incoming batch is complete regardless of the tail window above.
        const sig = frameSig(e)
        if (sig !== null && seenSigs.has(sig)) {
          droppedByContent.push({ entryId: e.entryId, sig })
          continue
        }
        seenIds.add(e.entryId)
        if (sig !== null) seenSigs.add(sig)
        fresh.push(e)
      }

      // Optional diagnostic — enable in browser DevTools with
      //   localStorage.setItem('clawboo:debug-triple-render', 'true')
      // to capture the upstream source of duplicates if this path is hit.
      // Off by default.
      if (
        typeof window !== 'undefined' &&
        droppedByContent.length > 0 &&
        window.localStorage?.getItem('clawboo:debug-triple-render') === 'true'
      ) {
        console.warn('[clawboo:triple-render] dropped content-equivalent entries', {
          sessionKey,
          dropped: droppedByContent,
          stack: new Error().stack?.split('\n').slice(1, 6).join('\n'),
        })
      }

      if (fresh.length === 0) return state
      const merged = [...existing, ...fresh]
      next.set(sessionKey, merged.length > 500 ? merged.slice(-500) : merged)
      return { transcripts: next }
    }),

  setStreamingText: (sessionKey, text) =>
    set((state) => {
      const next = new Map(state.streamingText)
      if (text === null) {
        next.delete(sessionKey)
      } else {
        next.set(sessionKey, text)
      }
      return { streamingText: next }
    }),

  setStreamStart: (sessionKey, ts) =>
    set((state) => {
      // First-capture-wins: if a stream-start is already recorded, don't
      // overwrite. Mid-stream patches keep arriving but the original anchor
      // is what positions the card.
      if (state.streamStartedAt.has(sessionKey)) return state
      const next = new Map(state.streamStartedAt)
      next.set(sessionKey, ts)
      return { streamStartedAt: next }
    }),

  clearStreamStart: (sessionKey) =>
    set((state) => {
      if (!state.streamStartedAt.has(sessionKey)) return state
      const next = new Map(state.streamStartedAt)
      next.delete(sessionKey)
      return { streamStartedAt: next }
    }),

  clearTranscript: (sessionKey) =>
    set((state) => {
      const nextTranscripts = new Map(state.transcripts)
      const nextStreaming = new Map(state.streamingText)
      const nextStreamStart = new Map(state.streamStartedAt)
      nextTranscripts.delete(sessionKey)
      nextStreaming.delete(sessionKey)
      nextStreamStart.delete(sessionKey)
      return {
        transcripts: nextTranscripts,
        streamingText: nextStreaming,
        streamStartedAt: nextStreamStart,
      }
    }),

  setLastTokenUsage: (runId, inputTokens, outputTokens) =>
    set((state) => {
      const next = new Map(state.lastTokenUsage)
      next.set(runId, { inputTokens, outputTokens })
      return { lastTokenUsage: next }
    }),
}))
