/**
 * Codex Boo. Its own chunk: importing this module pulls in the locked artwork, so only
 * `loadBooVariant('codex')` should reach it.
 */
import { CODEX_BOO_SVG } from './artwork/codex'
import { BOO_VARIANT_META } from './meta'
import { resolveTint } from './resolve'
import { tintCodex } from './tint/codex'
import type { BooVariantRenderer } from './types'

export const booVariant: BooVariantRenderer = {
  meta: BOO_VARIANT_META.codex,
  render(tint) {
    /* Codex has no contrast guard of its own: its glyph flips to a dark ink rather than refusing,
       and no generated palette colour is unusable. This still goes through resolveTint so a
       malformed colour draws the locked artwork instead of throwing into the render pass. */
    const { tint: use } = resolveTint(tint, () => true)
    return use == null ? CODEX_BOO_SVG : tintCodex(CODEX_BOO_SVG, use)
  },
}
