import type { TranscriptEntry } from '@clawboo/protocol'
import { parseToolMarkdown } from '@clawboo/protocol'

// ─── pickLatestActivity ──────────────────────────────────────────────────────
//
// Selects what to show in a Boo's live activity band when the agent is running.
// Priority: in-flight streaming text > most recent assistant message > most
// recent tool call. Skips thinking/meta/user — we want to show what the agent is
// *doing*, not its private reasoning or the user's own prompt.
//
// A tool call carries the BARE label, not a rendered string. It used to hand back
// the literal `[[tool: <label>]]`, which the band printed verbatim, so a person
// watching their Boo work read internal markup instead of a sentence. Formatting
// belongs to whatever draws it.

export type PickedActivity =
  | { kind: 'streaming'; text: string }
  | { kind: 'assistant'; text: string }
  | { kind: 'tool'; text: string }
  | null

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
    if (e.kind === 'tool') {
      const parsed = parseToolMarkdown(e.text)
      const label = parsed.label?.trim() || 'tool'
      return { kind: 'tool', text: label }
    }
    // skip 'thinking', 'meta', 'user'
  }
  return null
}
