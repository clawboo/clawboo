/**
 * Parses an @mention from the beginning of a message.
 * Returns the matched agent's ID and the message with the @mention stripped.
 * If no match, returns null targetAgentId (will default to leader).
 */
export function parseMention(
  message: string,
  teamAgents: { id: string; name: string }[],
): { targetAgentId: string | null; cleanedMessage: string } {
  if (!message.startsWith('@')) {
    return { targetAgentId: null, cleanedMessage: message }
  }

  // Text after the '@'
  const afterAt = message.slice(1)

  // Sort by name length descending for longest-prefix match
  const sorted = [...teamAgents].sort((a, b) => b.name.length - a.name.length)

  for (const agent of sorted) {
    if (afterAt.toLowerCase().startsWith(agent.name.toLowerCase())) {
      const rest = afterAt.slice(agent.name.length)
      // Must be followed by whitespace, end of string, or nothing
      if (rest.length === 0 || /^\s/.test(rest)) {
        return {
          targetAgentId: agent.id,
          cleanedMessage: rest.trimStart(),
        }
      }
    }
  }

  return { targetAgentId: null, cleanedMessage: message }
}
