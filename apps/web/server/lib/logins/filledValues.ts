// What a fill put into an agent's page, kept in memory so it can be masked on
// the way back out.
//
// A filled password is in the page, and the agent drives that page: its own
// browser tools can read a field or a page's text. So every browser tool result
// for that agent is masked against the passwords filled into its browser before
// the model sees it (and so before the audit row or an event stores it), as it
// was filled, as JSON writes it, and as an address or a form body encodes it.
// The same values are also lent to the storage scrub, which masks only values
// of 12 characters or more; the mask here is what covers shorter ones.
//
// WHAT THIS DOES NOT DO. It masks a value spelled as it was filled. An agent that
// transforms it first (reverses it, encodes it, sends it to a page of its own with
// a script) is not stopped here: the fill protects the vault and every other
// login, not the value once it is in the agent's page. Saying more would be
// claiming a wall that is not there.

import { REDACTION_MASK } from '@clawboo/logger'

import { lendSecretValues } from '../secretsVault'

/** Shorter than this and a "password" is a word; masking it would wipe page text. */
const MIN_MASKED_LENGTH = 4
/** How long a filled value stays masked. Longer than any browser stays open idle. */
const KEEP_MS = 24 * 60 * 60_000
/** Per agent, newest kept. */
const MAX_PER_AGENT = 32

interface Filled {
  value: string
  at: number
}

const byAgent = new Map<string, Filled[]>()
const LEND_OWNER = 'website-login-fills'

function prune(now: number): void {
  for (const [agentId, list] of byAgent) {
    const kept = list.filter((f) => now - f.at <= KEEP_MS)
    if (kept.length === 0) byAgent.delete(agentId)
    else if (kept.length !== list.length) byAgent.set(agentId, kept)
  }
}

function relend(): void {
  const all = new Set<string>()
  for (const list of byAgent.values()) for (const f of list) all.add(f.value)
  lendSecretValues(LEND_OWNER, all.size > 0 ? all : null)
}

/** Record values a fill put into this agent's page. */
export function noteFilledValues(agentId: string, values: readonly (string | null)[]): void {
  const now = Date.now()
  prune(now)
  const list = byAgent.get(agentId) ?? []
  for (const value of values) {
    if (!value || value.length < MIN_MASKED_LENGTH) continue
    const i = list.findIndex((f) => f.value === value)
    if (i >= 0) list.splice(i, 1)
    list.push({ value, at: now })
  }
  while (list.length > MAX_PER_AGENT) list.shift()
  if (list.length > 0) byAgent.set(agentId, list)
  relend()
}

/** A value as filled, as a JSON string spells it (a script's result usually comes
 *  back as JSON), and as an address or a form body encodes it (a request a browser
 *  tool shows, a form sent with GET). */
function spellingsOf(value: string): string[] {
  const uri = encodeURIComponent(value)
  return [
    value,
    JSON.stringify(value).slice(1, -1),
    uri,
    uri.replace(/%20/g, '+'),
    uri.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase()),
  ]
}

/** Mask every value filled into this agent's browser in `text`. */
export function maskFilledValues(agentId: string, text: string): string {
  const list = byAgent.get(agentId)
  if (!list || list.length === 0 || !text) return text
  const now = Date.now()
  let out = text
  // Longest first, so a value that contains another is masked whole.
  const values = [
    ...new Set(list.filter((f) => now - f.at <= KEEP_MS).flatMap((f) => spellingsOf(f.value))),
  ].sort((a, b) => b.length - a.length)
  for (const value of values) {
    if (out.includes(value)) out = out.split(value).join(REDACTION_MASK)
  }
  return out
}

/** Test seam. */
export function resetFilledValuesForTests(): void {
  byAgent.clear()
  lendSecretValues(LEND_OWNER, null)
}
