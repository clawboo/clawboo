// renderMention — highlights @AgentName at message start in sent message bubbles.

import type { ReactNode } from 'react'

/**
 * Renders message text with leading @mention highlighted in accent color.
 * Matches the same longest-prefix, case-insensitive logic as `parseMention`.
 * Only highlights the leading @mention (not mid-message mentions).
 */
export function renderMessageWithMentions(text: string, knownAgentNames: string[]): ReactNode {
  if (!text.startsWith('@')) return text

  const afterAt = text.slice(1)

  // Sort by length descending for longest-prefix match
  const sorted = [...knownAgentNames].sort((a, b) => b.length - a.length)

  for (const name of sorted) {
    if (afterAt.toLowerCase().startsWith(name.toLowerCase())) {
      const rest = afterAt.slice(name.length)
      // Must be followed by whitespace or end-of-string
      if (rest.length === 0 || /^\s/.test(rest)) {
        return (
          <>
            <span className="font-semibold text-accent">@{name}</span>
            {rest}
          </>
        )
      }
    }
  }

  // No match — return as-is
  return text
}
