// Turning a pack's provenance into something a user can act on.
//
// Most of this catalog is other people's work, adapted under a permissive
// licence. The honest framing is that Clawboo curated it, not that Clawboo
// wrote it, and the marketplace should say which is which on every card.
//
// The wording here is deliberately narrow. Clawboo does check licences, scan
// for known injection patterns, pin every import to a commit and verify a
// digest before anything is written. It does NOT audit what an agent will do
// once deployed. So nothing in this module may say safe, verified, vetted,
// trusted or approved; it says what was actually checked and leaves the
// judgement with the person deploying.

import type { CatalogIndex, CatalogProvenance } from './catalogTypes'

export type PackOrigin = 'community' | 'builtin'

/** Provenance for a pack id, or undefined when the index predates it. */
export function provenanceFor(
  index: CatalogIndex | null,
  packId: string | undefined,
): CatalogProvenance | undefined {
  if (!index?.packs || !packId) return undefined
  return index.packs.find((p) => p.id === packId)?.provenance
}

/**
 * Community content is anything adapted from an upstream project. Packs written
 * for Clawboo are builtin. The distinction drives the card badge, so it is
 * derived from `adaptation` rather than from the publisher name: a first-party
 * publisher could still be shipping adapted content.
 */
export function originOf(p: CatalogProvenance | undefined): PackOrigin {
  return p && p.adaptation !== 'original' ? 'community' : 'builtin'
}

/** `wshobson/agents` from a full GitHub URL, for a compact card label. */
export function repoLabel(repo: string | undefined): string | undefined {
  if (!repo) return undefined
  return repo.replace(/^https?:\/\/(www\.)?github\.com\//, '').replace(/\.git$/, '')
}

/** First 7 characters of the pinned commit, the usual short-sha convention. */
export function shortRef(ref: string | undefined): string | undefined {
  return ref && /^[0-9a-f]{40}$/i.test(ref) ? ref.slice(0, 7) : ref
}

/** One line naming who wrote it and under what licence. */
export function attributionLine(p: CatalogProvenance | undefined): string | null {
  if (!p) return null
  const who = p.authors?.length ? p.authors.join(', ') : repoLabel(p.repo)
  if (p.adaptation === 'original') return `Written for Clawboo. ${p.license}.`
  return who
    ? `Adapted from work by ${who}. ${p.license}.`
    : `Adapted from a community project. ${p.license}.`
}

/**
 * What Clawboo actually checked, and what it did not. Shown once on the
 * marketplace rather than repeated per card.
 */
export const COMMUNITY_DISCLOSURE =
  'Most of this catalog is community work, adapted from open-source projects by ' +
  'their original authors. Clawboo checks the licence, pins every import to a ' +
  'commit, verifies a content digest, and scans for known prompt-injection ' +
  'patterns. It does not audit what an agent will do once you deploy it. ' +
  'Review anything you deploy, the same as any other marketplace.'
