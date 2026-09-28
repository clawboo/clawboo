/**
 * Hermes Boo for light surfaces.
 *
 * Hermes is the one variant with two locked files, and they are 178KB of the 188KB total, so they
 * live in separate modules: a light-theme viewer must never download the dark artwork.
 */
import { HERMES_BOO_LIGHT_SVG } from './artwork/hermes-light'
import { BOO_VARIANT_META } from './meta'
import { resolveTint } from './resolve'
import { hermesLegibility, tintHermes } from './tint/hermes'
import type { BooVariantRenderer } from './types'

const legible = (hex: string): boolean => hermesLegibility(hex).ok

export const booVariant: BooVariantRenderer = {
  meta: BOO_VARIANT_META.hermes,
  render(tint) {
    const { tint: use } = resolveTint(tint, legible)
    return use == null ? HERMES_BOO_LIGHT_SVG : tintHermes(HERMES_BOO_LIGHT_SVG, use)
  },
}
