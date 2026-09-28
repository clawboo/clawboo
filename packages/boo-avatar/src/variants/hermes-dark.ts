/**
 * Hermes Boo for dark surfaces.
 *
 * A separate file rather than a CSS switch: the dark artwork adds a white halo stroke under every
 * black path and a filled white backing, so the mark keeps its edge light and its headband crescent
 * on a dark page.
 */
import { HERMES_BOO_DARK_SVG } from './artwork/hermes-dark'
import { BOO_VARIANT_META } from './meta'
import { tintHermes } from './tint/hermes'
import type { BooVariantRenderer } from './types'

export const booVariant: BooVariantRenderer = {
  meta: BOO_VARIANT_META.hermes,
  render(tint) {
    return tint == null ? HERMES_BOO_DARK_SVG : tintHermes(HERMES_BOO_DARK_SVG, tint)
  },
}
