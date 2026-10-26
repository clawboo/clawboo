/**
 * Makes a drawing's internal ids unique: to its colour here, and to its mounted copy in the UI.
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
 *
 * The tint alone is not enough once two copies of one colour share a page. Their ids then match,
 * and when the first copy is hidden (a collapsed sidebar keeps its tiles mounted) every later copy
 * borrows paints the browser will not draw: under `display: none` its gradients and filters, under
 * `visibility: hidden` its clip paths, which then clip the whole body away. `scopeSvgIds` closes
 * that by suffixing each mounted copy with its own scope.
 */

/**
 * Ids the document actually points at. A group id nothing references cannot change a drawing.
 *
 * The id class stops at `(`, whitespace and quotes, none of which an id holds. A class that let a
 * reference run on through `(` would rescan the rest of the string from every `url(#`, which is
 * quadratic on a long run of them.
 */
function referencedIds(svg: string): Set<string> {
  const refs = new Set<string>()
  for (const m of svg.matchAll(/url\(#([^()\s"']+)\)/g)) refs.add(m[1])
  for (const m of svg.matchAll(/href="#([^"]+)"/g)) refs.add(m[1])
  return refs
}

const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/**
 * Append `suffix` to every referenced id in `svg`.
 *
 * Only ids the same document references are renamed: those are the ones a collision can repaint.
 * Definition and reference are rewritten together, matched with their surrounding quotes or
 * parenthesis so one id cannot be caught as the prefix of a longer one.
 */
function suffixIds(svg: string, suffix: string): string {
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

/** Suffix every referenced id in `svg` with `tint`'s six digits. */
export function namespaceIds(svg: string, tint: string): string {
  return suffixIds(svg, `-${tint.replace('#', '').toUpperCase()}`)
}

/**
 * Suffix every referenced id in `svg` with `scope`, for a component that inlines the drawing.
 *
 * Call it once per mounted copy with a scope no other copy shares (React's `useId`), so each copy
 * resolves its paints inside its own svg wherever the others are and whether or not they are shown.
 * Characters outside `[A-Za-z0-9_-]` are dropped from the scope so it stays a plain XML name.
 */
export function scopeSvgIds(svg: string, scope: string): string {
  const clean = scope.replace(/[^A-Za-z0-9_-]/g, '')
  return clean ? suffixIds(svg, `-${clean}`) : svg
}
