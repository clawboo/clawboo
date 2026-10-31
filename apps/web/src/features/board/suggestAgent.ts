// Who should do a one-sentence task: the New task dialog's suggestion.
//
// The words of the sentence are matched against each candidate's name and its
// one-line role (from its SOUL.md, via GET /api/teams/member-roles). A word in
// the name counts twice, a word in the role once, so "ask Ada to draft the post"
// goes to Ada even when a writer's role says "draft". Words are compared after a
// light suffix trim, so "drafting" meets "drafts" and "writer" meets "write".
// With no match, the fallback is the agent this browser last gave a task to, then
// the team lead, then the first member. The same order breaks a tie.

export interface AgentCandidate {
  id: string
  name: string
  teamId: string
  role: string | null
}

export type SuggestionReason = 'match' | 'last-used' | 'lead' | 'first'

export interface AgentSuggestion {
  agentId: string
  reason: SuggestionReason
}

export interface SuggestAgentInput {
  text: string
  /** In roster order. */
  candidates: readonly AgentCandidate[]
  /** Agents this browser gave a task to, most recent first. */
  recentAgentIds: readonly string[]
  /** Team leads, in team order. */
  leadAgentIds: readonly string[]
}

const NAME_WEIGHT = 2
const ROLE_WEIGHT = 1

/** Words that say nothing about who should do the work. */
const STOPWORDS = new Set(
  [
    'about all also and any are can could for from get has have her his how into its',
    'just make more most need new not now our out please should some task than that',
    'the their them then there they this very was what when which who why will with',
    'would you your',
  ]
    .join(' ')
    .split(' '),
)

/** Longest first, so "ers" is tried before "er" and "s". */
const SUFFIXES = ['ings', 'ing', 'ers', 'ies', 'ied', 'er', 'ed', 'es', 's']

/** A word with one common suffix trimmed, then a final e or y, keeping at least
 *  three letters: draft, drafts, drafting and drafted all read "draft". */
export function stem(word: string): string {
  let w = word
  for (const suffix of SUFFIXES) {
    if (suffix === 's' && w.endsWith('ss')) break
    if (w.endsWith(suffix) && w.length - suffix.length >= 3) {
      w = w.slice(0, -suffix.length)
      break
    }
  }
  if (w.length > 3 && (w.endsWith('e') || w.endsWith('y'))) w = w.slice(0, -1)
  return w
}

/** The distinct stems of the words in `text` that can say who does the work. */
export function wordStems(text: string): Set<string> {
  const out = new Set<string>()
  for (const word of text.toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (word.length < 3 || STOPWORDS.has(word)) continue
    out.add(stem(word))
  }
  return out
}

export function suggestAgent(input: SuggestAgentInput): AgentSuggestion | null {
  const { candidates } = input
  if (candidates.length === 0) return null
  const ids = new Set(candidates.map((c) => c.id))
  const recent = input.recentAgentIds.find((id) => ids.has(id))
  const lead = input.leadAgentIds.find((id) => ids.has(id))

  // The fallback order, which also breaks a tie between equal matches.
  const order = [recent, lead, ...candidates.map((c) => c.id)].filter(
    (id): id is string => id !== undefined,
  )
  const rank = (id: string): number => order.indexOf(id)

  const words = wordStems(input.text)
  let best: { id: string; score: number } | null = null
  if (words.size > 0) {
    for (const c of candidates) {
      const name = wordStems(c.name)
      const role = c.role ? wordStems(c.role) : new Set<string>()
      let score = 0
      for (const w of words) {
        if (name.has(w)) score += NAME_WEIGHT
        else if (role.has(w)) score += ROLE_WEIGHT
      }
      if (score === 0) continue
      if (!best || score > best.score || (score === best.score && rank(c.id) < rank(best.id))) {
        best = { id: c.id, score }
      }
    }
  }
  if (best) return { agentId: best.id, reason: 'match' }
  if (recent) return { agentId: recent, reason: 'last-used' }
  if (lead) return { agentId: lead, reason: 'lead' }
  return { agentId: candidates[0]!.id, reason: 'first' }
}
