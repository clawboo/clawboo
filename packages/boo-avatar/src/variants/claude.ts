/**
 * Claude Boo. Its own chunk: importing this module pulls in the locked artwork, so only
 * `loadBooVariant('claude')` should reach it.
 */
import { CLAUDE_BOO_SVG } from './artwork/claude'
import { BOO_VARIANT_META } from './meta'
import { tintClaude } from './tint/claude'
import type { BooVariantRenderer } from './types'

export const booVariant: BooVariantRenderer = {
  meta: BOO_VARIANT_META.claude,
  render(tint) {
    return tint == null ? CLAUDE_BOO_SVG : tintClaude(CLAUDE_BOO_SVG, tint)
  },
}
