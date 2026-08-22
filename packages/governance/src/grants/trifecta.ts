// The "lethal trifecta": reads private data + ingests untrusted content + can
// send bytes out. Any one leg is ordinary. All three armed inside one run is the
// shape of an exfiltration chain, and no amount of tool-description sanitising
// prevents it — the model is supposed to read those descriptions.
//
// Tracked as a UNION across the run rather than per call, because the attack is
// a chain: one tool reads the repo, another fetches an attacker-authored page,
// a third posts somewhere. No single call looks dangerous.

import { NO_TRIFECTA, type TrifectaTags } from './types'

/** OR the legs together. Missing operands contribute nothing. */
export function unionTrifecta(...tags: readonly (TrifectaTags | null | undefined)[]): TrifectaTags {
  let readsPrivateData = false
  let ingestsUntrustedContent = false
  let canEgress = false
  for (const t of tags) {
    if (!t) continue
    readsPrivateData ||= t.readsPrivateData
    ingestsUntrustedContent ||= t.ingestsUntrustedContent
    canEgress ||= t.canEgress
  }
  return { readsPrivateData, ingestsUntrustedContent, canEgress }
}

/** All three legs armed. */
export function isLethalTrifecta(tags: TrifectaTags | null | undefined): boolean {
  if (!tags) return false
  return tags.readsPrivateData && tags.ingestsUntrustedContent && tags.canEgress
}

/** How many legs are armed. Drives the graph's trifecta ring (0-3). */
export function trifectaLegCount(tags: TrifectaTags | null | undefined): number {
  if (!tags) return 0
  return (
    (tags.readsPrivateData ? 1 : 0) +
    (tags.ingestsUntrustedContent ? 1 : 0) +
    (tags.canEgress ? 1 : 0)
  )
}

/**
 * Which single leg to drop to break the chain, cheapest first.
 *
 * Deliberately actionable rather than descriptive: "you are at risk" is useless
 * in a dialog, "revoke egress on this grant and the chain is broken" is not.
 * Returns [] when the trifecta is not armed.
 */
export function breakTrifectaSuggestions(tags: TrifectaTags | null | undefined): string[] {
  if (!isLethalTrifecta(tags)) return []
  // Ordered by how little a user usually loses by dropping that leg. Egress is
  // first because a connector that only reads is still useful; private-data
  // access is last because removing it usually defeats the point of the grant.
  return [
    'Remove egress: restrict this grant to tools that cannot send data off the machine.',
    'Remove untrusted input: stop this agent from fetching attacker-authorable content.',
    'Remove private access: scope this grant away from the private data it reads.',
  ]
}

export { NO_TRIFECTA }
