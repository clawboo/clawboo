/**
 * Claude Boo. Its own chunk: importing this module pulls in the locked artwork, so only
 * `loadBooVariant('claude')` should reach it.
 */
import { CLAUDE_BOO_SVG } from './artwork/claude'
import { BOO_VARIANT_META } from './meta'
import { resolveTint } from './resolve'
import { claudeLegibility, tintClaude } from './tint/claude'
import type { BooVariantRenderer } from './types'

const legible = (hex: string): boolean => claudeLegibility(hex).ok

export const booVariant: BooVariantRenderer = {
  meta: BOO_VARIANT_META.claude,
  render(tint) {
    const { tint: use } = resolveTint(tint, legible)
    return use == null ? CLAUDE_BOO_SVG : tintClaude(CLAUDE_BOO_SVG, use)
  },
}
