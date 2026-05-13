/**
 * Genuine team-leader detection.
 *
 * With Boo Zero acting as the universal team leader across every team,
 * Clawboo no longer needs to force every team to designate one of its
 * members as `leaderAgentId`. We only want to keep that field set when
 * an agent's role / name genuinely matches a leadership archetype
 * (CTO, Team Lead, Project Manager, Operator, etc.) — in which case
 * Boo Zero treats them as the "team-internal lead" that sits between
 * Boo Zero and the rest of the team.
 *
 * This module exports:
 *   - `LEADERSHIP_KEYWORDS`: the canonical keyword list.
 *   - `detectGenuineLeader({name, role})`: pure boolean check against
 *     EITHER field, case-insensitive, word-boundary anchored.
 *
 * Used at team-deploy time (`CreateTeamModal`, `OnboardingWizard`) and
 * for generating each team's brief (`buildTeamBrief`).
 */

/**
 * Canonical leadership keywords / phrases. Order is not significant.
 * Matched against the agent's `name` and `role` (case-insensitive,
 * word-boundary anchored to avoid false positives like "CTOgraphy" or
 * "Manager-of-Records-but-actually-an-IC").
 */
export const LEADERSHIP_KEYWORDS: readonly string[] = [
  // C-suite
  'CEO',
  'CTO',
  'CFO',
  'COO',
  'CMO',
  'CIO',
  'Chief',
  // Director-tier
  'VP',
  'VP of',
  'Founder',
  'President',
  'Principal',
  'Director',
  'Head of',
  // Leads
  'Team Lead',
  'Tech Lead',
  'Project Lead',
  'Product Lead',
  'Engineering Lead',
  // Managers
  'Project Manager',
  'Product Manager',
  'Engineering Manager',
  'Program Manager',
  'General Manager',
  // Coordinators / orchestrators
  'Operator',
  'Orchestrator',
  'Coordinator',
  'Conductor',
]

/**
 * Build the regex from `LEADERSHIP_KEYWORDS` once at module load.
 *
 * Word-boundary semantics: `\b` requires a non-word char on either side.
 * For multi-word phrases ("Team Lead") `\b...\b` works because the
 * surrounding text — start/end of string, comma, period, whitespace —
 * are non-word. For "Chief" we use `\b` only; "Chief Scientist" matches
 * "Chief" alone, intentionally — there are many real "Chief X" roles
 * that should count as leadership.
 *
 * Escapes any regex meta-chars in the keywords (defensive — none today
 * but the list may grow).
 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

const LEADERSHIP_RE = new RegExp(
  `\\b(?:${LEADERSHIP_KEYWORDS.map((k) =>
    // Collapse whitespace so "Team   Lead" still matches; tolerate hyphen.
    escapeRegExp(k).replace(/\s+/g, '[\\s-]+'),
  ).join('|')})\\b`,
  'i',
)

/**
 * Negative-match guards: substrings that LOOK leadership-y but represent
 * individual contributors. Checked AFTER the positive regex passes so we
 * never reject a real "Tech Lead" by accident.
 *
 * Each entry is the surrounding context that disqualifies the match:
 *   "Lead Engineer" → "Lead" is positional ("first chair"), not a title.
 *   "Senior X", "Staff X" → seniority adjectives, not leadership roles.
 */
const NEGATIVE_PATTERNS: readonly RegExp[] = [
  /\bLead\s+(Engineer|Developer|Designer|Researcher|Scientist|Analyst|Writer|Reviewer)\b/i,
  /\b(Senior|Staff|Principal\s+Engineer|Principal\s+Developer)\b/i,
]

export interface GenuineLeaderCandidate {
  name: string
  /** Catalog role string, or an empty string if unknown. */
  role: string
}

/**
 * Returns true when EITHER the agent's `name` or `role` matches one of
 * the canonical leadership keywords AND no negative pattern fires.
 *
 * Pure. Safe to call from anywhere.
 */
export function detectGenuineLeader(agent: GenuineLeaderCandidate): boolean {
  const haystack = `${agent.name} ${agent.role}`.trim()
  if (haystack.length === 0) return false

  if (!LEADERSHIP_RE.test(haystack)) return false

  for (const neg of NEGATIVE_PATTERNS) {
    if (neg.test(haystack)) return false
  }

  return true
}

/**
 * Returns the first matched leadership keyword, or null if no match.
 * Useful for surfacing "detected via 'CTO'" in the team brief.
 */
export function matchedLeadershipKeyword(agent: GenuineLeaderCandidate): string | null {
  const haystack = `${agent.name} ${agent.role}`.trim()
  if (haystack.length === 0) return null

  for (const neg of NEGATIVE_PATTERNS) {
    if (neg.test(haystack)) return null
  }

  const matchResult = haystack.match(LEADERSHIP_RE)
  if (!matchResult || matchResult.length === 0) return null

  // Return the canonical (original-case) keyword that matched, not the
  // captured text from the haystack — keeps the brief consistent.
  const matchedText = matchResult[0]!.toLowerCase()
  const matchedNorm = matchedText.replace(/[\s-]+/g, ' ')
  return (
    LEADERSHIP_KEYWORDS.find((kw) => {
      const normalised = kw.toLowerCase().replace(/\s+/g, ' ')
      return matchedNorm === normalised
    }) ?? null
  )
}
