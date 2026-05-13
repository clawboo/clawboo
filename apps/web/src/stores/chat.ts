import { create } from 'zustand'
import type { TranscriptEntry } from '@clawboo/protocol'

// ─── Store ────────────────────────────────────────────────────────────────────
// Keyed by sessionKey so multiple agent conversations are held simultaneously.

interface ChatStore {
  /** Committed transcript entries, keyed by sessionKey. */
  transcripts: Map<string, TranscriptEntry[]>
  /** Live streaming text that hasn't been committed yet, keyed by sessionKey. */
  streamingText: Map<string, string>
  /** Token usage from final chat events, keyed by runId. */
  lastTokenUsage: Map<string, { inputTokens: number; outputTokens: number }>

  /** Append one or more entries to a session's transcript. */
  appendTranscript: (sessionKey: string, entries: TranscriptEntry[]) => void

  /** Set (or clear) the live streaming text for a session. */
  setStreamingText: (sessionKey: string, text: string | null) => void

  /** Wipe all transcript + streaming state for a session. */
  clearTranscript: (sessionKey: string) => void

  /** Store token usage for a completed run. */
  setLastTokenUsage: (runId: string, inputTokens: number, outputTokens: number) => void
}

export const useChatStore = create<ChatStore>((set) => ({
  transcripts: new Map(),
  streamingText: new Map(),
  lastTokenUsage: new Map(),

  appendTranscript: (sessionKey, entries) =>
    set((state) => {
      const next = new Map(state.transcripts)
      const existing = next.get(sessionKey) ?? []

      // Dedup layer 1: entryId (preserves React key stability across re-fetches).
      const seenIds = new Set(existing.map((e) => e.entryId))

      // Dedup layer 2: content signature (defensive against the production
      // triple-render bug). When the upstream pipeline fires `appendOutputLines`
      // multiple times for the same Gateway frame, each call mints a fresh
      // entryId via `crypto.randomUUID()` — entryId dedup misses, and the
      // store ends up with N copies of the same message.
      //
      // Upstream root cause (Round 2, Phase A): the `commitChat` case in
      // `packages/events/src/handler.ts` does NOT guard against stale
      // terminal events for already-closed runs (the `closedRuns` guard
      // exists only for `updateAgentStatus`). When the Gateway emits
      // multiple `chat:final` frames for the same runId — which can happen
      // legitimately during exec-approval flows AND happens spuriously in
      // some Gateway configurations — every frame produces a fresh
      // `commitChat` intent that calls `appendOutputLines` with new
      // entryIds. We cannot add a runId-only guard at the handler layer
      // because legitimate post-approval continuations have the SAME runId
      // with DIFFERENT text and we want those through.
      //
      // The content signature collapses entries that are clearly the same
      // logical event:
      //
      //   key = `${kind}|${role}|${timestampMs/1000|0}|${text.slice(0,160)}`
      //
      // Scoping is implicit in `sessionKey` (we only check against entries on
      // the same session). The 1-second timestamp bucket allows real
      // re-utterances of the same text later in the conversation through,
      // but blocks the same-frame triplication that production exhibits.
      // First 160 chars of text is plenty to disambiguate distinct messages
      // while keeping the signature cheap.
      function contentSig(e: {
        kind?: string
        role?: string
        timestampMs?: number | null
        text?: string
      }): string {
        const k = e.kind ?? ''
        const r = e.role ?? ''
        const tsBucket = Math.floor((e.timestampMs ?? 0) / 1000)
        const t = (e.text ?? '').slice(0, 160)
        return `${k}|${r}|${tsBucket}|${t}`
      }
      const seenSigs = new Set(existing.map(contentSig))

      const fresh: typeof entries = []
      const droppedByContent: { entryId: string; sig: string }[] = []
      for (const e of entries) {
        if (seenIds.has(e.entryId)) continue
        const sig = contentSig(e)
        if (seenSigs.has(sig)) {
          droppedByContent.push({ entryId: e.entryId, sig })
          continue
        }
        seenIds.add(e.entryId)
        seenSigs.add(sig)
        fresh.push(e)
      }

      // Optional diagnostic (Phase A4) — enable in browser DevTools with
      //   localStorage.setItem('clawboo:debug-triple-render', 'true')
      // to capture the actual upstream source of duplicates the next time
      // production hits this path. Off by default.
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

  clearTranscript: (sessionKey) =>
    set((state) => {
      const nextTranscripts = new Map(state.transcripts)
      const nextStreaming = new Map(state.streamingText)
      nextTranscripts.delete(sessionKey)
      nextStreaming.delete(sessionKey)
      return { transcripts: nextTranscripts, streamingText: nextStreaming }
    }),

  setLastTokenUsage: (runId, inputTokens, outputTokens) =>
    set((state) => {
      const next = new Map(state.lastTokenUsage)
      next.set(runId, { inputTokens, outputTokens })
      return { lastTokenUsage: next }
    }),
}))
