/**
 * Makes a tinted variant's internal ids unique to its colour.
 *
 * A variant is inlined into the page as SVG, not loaded as an image, so every `url(#id)` on the
 * page resolves against the whole document: the first `codexBodyGradient` the document holds wins
 * and every later one is ignored. Two Codex agents on different teams therefore both paint in
 * whichever colour mounted first, which is the same collision the generated mascot avoids by
 * putting its tint in its gradient id.
 *
 * The tint goes into the id verbatim rather than hashed, for the same reason it does there: a
 * short hash has far fewer values than there are colours, so two tints would collide and
 * reintroduce the bug. Hermes mints its own ids inside its tinter, which is why it is not a caller.
 */

/** Ids the document actually points at. A group id nothing references cannot change a drawing. */
function referencedIds(svg: string): Set<string> {
  const refs = new Set<string>()
  for (const m of svg.matchAll(/url\(#([^)]+)\)/g)) refs.add(m[1])
  for (const m of svg.matchAll(/href="#([^"]+)"/g)) refs.add(m[1])
  return refs
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Suffix every referenced id in `svg` with `tint`'s six digits.
 *
 * Only ids the same document references are renamed: those are the ones a collision can repaint.
 * Definition and reference are rewritten together, matched with their surrounding quotes or
 * parenthesis so one id cannot be caught as the prefix of a longer one.
 */
export function namespaceIds(svg: string, tint: string): string {
  const suffix = `-${tint.replace('#', '').toUpperCase()}`
  let out = svg
  for (const id of referencedIds(svg)) {
    const e = escapeRe(id)
    out = out
      .replace(new RegExp(`id="${e}"`, 'g'), `id="${id}${suffix}"`)
      .replace(new RegExp(`url\\(#${e}\\)`, 'g'), `url(#${id}${suffix})`)
      .replace(new RegExp(`href="#${e}"`, 'g'), `href="#${id}${suffix}"`)
  }
  return out
}
