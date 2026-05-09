import type { TranscriptEntry } from '@clawboo/protocol'
import { parseToolMarkdown } from '@clawboo/protocol'

// ─── pickLatestActivity ──────────────────────────────────────────────────────
//
// Selects what to show in a Boo's live activity band when the agent is running.
// Priority: in-flight streaming text > most recent assistant message > most
// recent tool call (formatted as `[[tool: <label>]]`). Skips thinking/meta/user
// — we want to show what the agent is *doing*, not its private reasoning or
// the user's own prompt.

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
      return { kind: 'tool', text: `[[tool: ${label}]]` }
    }
    // skip 'thinking', 'meta', 'user'
  }
  return null
}
