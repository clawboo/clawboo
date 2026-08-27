// When the registry band is worth loading.
//
// PURE AND SEPARATE because this one predicate decides whether four hundred
// entries are reachable at all, and it has been wrong in two different
// directions. It is also the only thing standing between first paint and a
// 220 KB dynamic import, so it cannot simply return true.
//
// WHAT IT USED TO BE: `filter === 'community' || (query !== '' && curatedHits
// === 0)`. The second clause reads as "fall back to the registry when nothing
// vouched-for matched", which is reasonable until you notice it means one
// curated hit hides every registry match behind it. Searching "search" matched
// Exa on a tag and buried sixty-seven registry entries; "file" buried twenty.
// Search was the only route into the band and it failed silently on exactly the
// generic words someone browsing types.

export interface CommunityBandInput {
  /** The active filter pill. */
  categoryFilter: string
  /** The search box, already trimmed. */
  query: string
  /** How many curated entries matched. */
  curatedHits: number
}

/**
 * Whether to pull in and show the registry band.
 *
 * THE EMPTY QUERY NEVER LOADS IT. That is the first-paint guarantee, and the
 * only way to see the band without typing is to ask for it by name with the
 * filter pill.
 *
 * THE SINGLE-CHARACTER PATH IS DELIBERATE. A flat two-character minimum looks
 * tidier and would have been a regression: nine one-character queries return no
 * curated match at all, and each of them opens the band today. Keeping the
 * old miss-fallthrough alongside the new length rule preserves them.
 */
export function wantsCommunityBand(input: CommunityBandInput): boolean {
  if (input.categoryFilter === 'community') return true
  if (input.query === '') return false
  return input.query.length >= 2 || input.curatedHits === 0
}
