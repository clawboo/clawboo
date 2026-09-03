import type { TranscriptEntry } from '@clawboo/protocol'
import { parseToolMarkdown } from '@clawboo/protocol'

// ─── pickLatestActivity ──────────────────────────────────────────────────────
//
// Selects what to show in a Boo's thought bubble while the agent is running.
// Newest wins: the scan walks backwards and returns the first entry it can say
// something about.
//
// Reasoning IS included. It used to be skipped as "private", but the bubble is
// the one surface that answers "what is it doing right now", and on a reasoning
// model the honest answer between two tool calls is the thinking itself. Held
// back, the bubble sat empty through the longest stretch of a run. `meta` and
// `user` are still skipped: neither is the agent doing anything.
//
// The tool branch returns the LABEL, not the `[[tool]]` protocol line. The
// caller renders text as-is, so the marker syntax has no business leaving here.

export type PickedActivityKind = 'streaming' | 'assistant' | 'thinking' | 'tool'

export type PickedActivity = { kind: PickedActivityKind; text: string } | null

export function pickLatestActivity(
  streamingText: string | null,
  entries: readonly TranscriptEntry[] | null,
): PickedActivity {
  if (streamingText && streamingText.trim()) {
    return { kind: 'streaming', text: streamingText }
  }
  if (!entries || entries.length === 0) return null

  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (!e || !e.text) continue
    if (e.kind === 'assistant') {
      return { kind: 'assistant', text: e.text }
    }
    if (e.kind === 'thinking') {
      return { kind: 'thinking', text: e.text }
    }
    if (e.kind === 'tool') {
      const parsed = parseToolMarkdown(e.text)
      return { kind: 'tool', text: parsed.label?.trim() || 'tool' }
    }
    // skip 'meta', 'user'
  }
  return null
}
