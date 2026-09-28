/**
 * Variant metadata and anchors. Data only, no artwork and no colour maths.
 *
 * The registry is imported from the package root, so anything it reaches has to stay light: the
 * four locked SVGs are 188KB raw and must never land in the main entry. That is why the anchors
 * live here rather than in the tinters that use them, and why `aspect` is written out rather than
 * parsed from a viewBox.
 */
import type { BooVariantId, BooVariantMeta } from './types'

/**
 * The middle stop of codexBodyGradient. It is the anchor because feeding it back through the
 * tinter reproduces the locked file byte for byte.
 */
export const CODEX_ANCHOR = '#7B95FC'

/** The middle stop of claudeBodyGradient, which is also the flat fill under the clipped gradient. */
export const CLAUDE_ANCHOR = '#EA7857'

/**
 * Hermes's body ink. Tinting Hermes with its own ink cannot change anything, because white carries
 * no chroma for a hue to ride on, so the tinter returns the locked bytes early.
 */
export const HERMES_INK = '#FFFFFF'

export const BOO_VARIANT_META: Record<BooVariantId, BooVariantMeta> = {
  codex: {
    id: 'codex',
    label: 'Codex Boo',
    originalLabel: 'Codex blue',
    originalColour: CODEX_ANCHOR,
    // viewBox="-9 -20 118 118"
    aspect: 118 / 118,
  },
  claude: {
    id: 'claude',
    label: 'Claude Boo',
    originalLabel: 'Claude terracotta',
    originalColour: CLAUDE_ANCHOR,
    // viewBox="0 -3 100 92"
    aspect: 92 / 100,
  },
  hermes: {
    id: 'hermes',
    label: 'Hermes Boo',
    originalLabel: 'Black and white',
    originalColour: null,
    // viewBox="-6.547 -20.689 113.638 113.638"
    aspect: 113.638 / 113.638,
  },
}
