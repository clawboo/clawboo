/**
 * Boo Zero's individual chat extends `@`-mention parsing beyond agents to
 * include teams. When the user types `@MarketingTeam, please research X`,
 * the chat handler injects that team's brief into the message preamble so
 * Boo Zero can reason about that specific team.
 *
 * The parser uses longest-prefix matching across BOTH teams and agents.
 * On a tie (rare — team and agent names could theoretically collide),
 * **teams win** because the team-mention intent is the new feature this
 * file exists for; an agent mention would still route through the normal
 * `parseMention` in team chats.
 *
 * Pure. No DOM / store access.
 */

export type MentionKind = 'team' | 'agent' | 'none'

export interface ParseTeamOrAgentMentionResult {
  kind: MentionKind
  /** The matched team or agent id, or null when nothing matched. */
  targetId: string | null
  /** The matched name (in its original casing from the input). */
  matchedName: string | null
  /** The message with the `@<Name>` prefix stripped (when matched). */
  cleanedMessage: string
}

export interface MentionCandidate {
  id: string
  name: string
}

const NO_MATCH: ParseTeamOrAgentMentionResult = {
  kind: 'none',
  targetId: null,
  matchedName: null,
  cleanedMessage: '',
}

/**
 * Parse an `@<Name>` mention at the start of `message`. Returns the kind
 * ('team' | 'agent' | 'none'), the matched id (when any), and the message
 * with the `@<Name>` prefix stripped.
 *
 * Matching rules:
 *   - Must start with `@` (after an optional leading whitespace trim).
 *   - The matched name is followed by whitespace, end-of-string, OR one
 *     of: `,`, `.`, `:`, `!`, `?`. Catches "@Marketing, please..." and
 *     "@Marketing: do X" naturally.
 *   - Longest-prefix match: "@SEO Boo" wins over "@SEO" when both exist.
 *   - Ties: teams beat agents.
 */
export function parseTeamOrAgentMention(
  message: string,
  teams: readonly MentionCandidate[] = [],
  agents: readonly MentionCandidate[] = [],
): ParseTeamOrAgentMentionResult {
  if (!message.startsWith('@')) return { ...NO_MATCH, cleanedMessage: message }

  const afterAt = message.slice(1)
  const lowerAfter = afterAt.toLowerCase()

  // Build a unified candidate list. We attach the kind here so the longest-
  // prefix sort below picks the right one. Teams listed first so that a
  // tie (identical names) resolves to a team.
  type Cand = { id: string; name: string; lower: string; kind: 'team' | 'agent' }
  const candidates: Cand[] = [
    ...teams.map<Cand>((t) => ({
      id: t.id,
      name: t.name,
      lower: t.name.toLowerCase(),
      kind: 'team',
    })),
    ...agents.map<Cand>((a) => ({
      id: a.id,
      name: a.name,
      lower: a.name.toLowerCase(),
      kind: 'agent',
    })),
  ]
  // Sort by descending name length so longer names match first.
  candidates.sort((a, b) => b.name.length - a.name.length)

  for (const cand of candidates) {
    if (!lowerAfter.startsWith(cand.lower)) continue
    const rest = afterAt.slice(cand.name.length)
    if (rest.length === 0 || /^[\s,.:!?]/.test(rest)) {
      // Strip the matched mention + any single immediately-following
      // separator character (so the cleaned message reads naturally).
      const trimmedRest =
        rest.length > 0 && /^[,.:!?]/.test(rest) ? rest.slice(1).trimStart() : rest.trimStart()
      return {
        kind: cand.kind,
        targetId: cand.id,
        matchedName: cand.name,
        cleanedMessage: trimmedRest,
      }
    }
  }

  return { ...NO_MATCH, cleanedMessage: message }
}
