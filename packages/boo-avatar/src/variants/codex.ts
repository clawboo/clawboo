/**
 * Codex Boo. Its own chunk: importing this module pulls in the locked artwork, so only
 * `loadBooVariant('codex')` should reach it.
 */
import { CODEX_BOO_SVG } from './artwork/codex'
import { BOO_VARIANT_META } from './meta'
import { tintCodex } from './tint/codex'
import type { BooVariantRenderer } from './types'

export const booVariant: BooVariantRenderer = {
  meta: BOO_VARIANT_META.codex,
  render(tint) {
    return tint == null ? CODEX_BOO_SVG : tintCodex(CODEX_BOO_SVG, tint)
  },
}
