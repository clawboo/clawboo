/**
 * Hermes Boo for dark surfaces.
 *
 * A separate file rather than a CSS switch: the dark artwork adds a white halo stroke under every
 * black path and a filled white backing, so the mark keeps its edge light and its headband crescent
 * on a dark page.
 */
import { HERMES_BOO_DARK_SVG } from './artwork/hermes-dark'
import { BOO_VARIANT_META } from './meta'
import { resolveTint } from './resolve'
import { hermesLegibility, tintHermes } from './tint/hermes'
import type { BooVariantRenderer } from './types'

const legible = (hex: string): boolean => hermesLegibility(hex).ok

export const booVariant: BooVariantRenderer = {
  meta: BOO_VARIANT_META.hermes,
  render(tint) {
    const { tint: use } = resolveTint(tint, legible)
    return use == null ? HERMES_BOO_DARK_SVG : tintHermes(HERMES_BOO_DARK_SVG, use)
  },
}
