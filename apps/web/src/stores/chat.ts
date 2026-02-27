import { create } from 'zustand'
import type { TranscriptEntry } from '@clawboo/protocol'

// ─── Store ────────────────────────────────────────────────────────────────────
// Keyed by sessionKey so multiple agent conversations are held simultaneously.

interface ChatStore {
  /** Committed transcript entries, keyed by sessionKey. */
  transcripts: Map<string, TranscriptEntry[]>
  /** Live streaming text that hasn't been committed yet, keyed by sessionKey. */
  streamingText: Map<string, string>

  /** Append one or more entries to a session's transcript. */
  appendTranscript: (sessionKey: string, entries: TranscriptEntry[]) => void

  /** Set (or clear) the live streaming text for a session. */
  setStreamingText: (sessionKey: string, text: string | null) => void

  /** Wipe all transcript + streaming state for a session. */
  clearTranscript: (sessionKey: string) => void
}

export const useChatStore = create<ChatStore>((set) => ({
  transcripts: new Map(),
  streamingText: new Map(),

  appendTranscript: (sessionKey, entries) =>
    set((state) => {
      const next = new Map(state.transcripts)
      const existing = next.get(sessionKey) ?? []
      next.set(sessionKey, [...existing, ...entries])
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
}))
