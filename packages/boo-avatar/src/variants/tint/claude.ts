/**
 * Recolours the locked Claude Boo from one hex.
 *
 * Claude Boo is painted from a single terracotta family: a five stop vertical ramp, a warm sheen,
 * one deepening colour used by every shade gradient, and a flat fill under the clipped gradient.
 * The middle ramp stop #EA7857 is the anchor, and it is also that flat fill, so a tint arrives on
 * the mark at full strength. Every other identity colour moves by the same OKLCH offset that takes
 * the anchor to the tint, which keeps the ramp's own lightness spread and hue drift intact.
 *
 * Not tinted: the chevron eyes, which stay the locked near-blacks so the face reads at 24px on any
 * body colour; the white gloss, which is neutral highlight rather than an identity colour; and the
 * ground shadow black.
 */
import { CLAUDE_ANCHOR } from '../meta'
import { contrast, shift } from '../colour'
import { namespaceIds } from './ids'

/** The identity colours of the locked file, by role. Each moves with the anchor. */
const IDENTITY = [
  '#F7A784',
  '#F18B67',
  '#EA7857',
  '#DC6348',
  '#C94A39', // claudeBodyGradient, top to hem
  '#A93C2F', // deepening: claudeShade, claudeFoot, claudeUnderTab
  '#FFEFE7', // warm sheen: claudeRimGloss
]

/** Colours that must NOT move: the white gloss, the two chevron near-blacks, the ground shadow. */
const NEUTRAL = ['#FFFFFF', '#1A1D28', '#0D0F16', '#000000']

/** The hem stop against a dark page, and the near-black eyes against the flat body they sit on. */
const HEM_LOCKED = '#C94A39'
const EYE_INK = '#1A1D28'
const DARK_SURFACE = '#0a0e1a'

const HEX = /#[0-9A-Fa-f]{6}/g

const norm = (hex: string): string => {
  const h = (hex.startsWith('#') ? hex : `#${hex}`).toUpperCase()
  if (!/^#[0-9A-F]{6}$/.test(h)) throw new Error(`tintClaude: not a 6 digit hex: ${hex}`)
  return h
}

/*
 * IDENTITY is a hand list, so a colour the artwork gained later would pass through untinted and
 * ship a locked terracotta on a tinted body. Every hex in the input must be claimed by one list.
 */
function assertCoverage(svgText: string): void {
  const seen = [...new Set(svgText.match(HEX) ?? [])].map((h) => h.toUpperCase())
  const stray = seen.filter((h) => !IDENTITY.includes(h) && !NEUTRAL.includes(h))
  if (stray.length) {
    throw new Error(
      `tintClaude: ${stray.join(', ')} is in neither IDENTITY nor NEUTRAL, so it would survive ` +
        'untinted. Add it to the right list.',
    )
  }
}

function recolour(svgText: string, tint: string): string {
  const map = new Map(IDENTITY.map((c) => [c, shift(c, CLAUDE_ANCHOR, tint)]))
  return svgText.replace(HEX, (m) => map.get(m.toUpperCase()) ?? m)
}

/**
 * What a tint costs Claude's two locked marks: the chevron eyes against the body, and the hem
 * against a dark page. `tintClaude` refuses below 4.5 and 3; the renderer uses this to find a
 * legible shade instead of refusing.
 */
export function claudeLegibility(tintHex: string): { ok: boolean; eyes: number; hem: number } {
  const tint = norm(tintHex)
  const eyes = contrast(EYE_INK, shift(CLAUDE_ANCHOR, CLAUDE_ANCHOR, tint))
  const hem = contrast(shift(HEM_LOCKED, CLAUDE_ANCHOR, tint), DARK_SURFACE)
  return { ok: eyes >= 4.5 && hem >= 3, eyes, hem }
}

/** The locked SVG recoloured to `tintHex`. Feeding the anchor must return the input unchanged. */
export function tintClaude(svgText: string, tintHex: string): string {
  assertCoverage(svgText)
  const tint = norm(tintHex)
  /*
   * The eyes stay locked, so a dark tint loses the face; the hem carries the silhouette on a dark
   * page. Both fail together on a deep tint, so neither check stands alone.
   */
  const { eyes, hem } = claudeLegibility(tint)
  if (eyes < 4.5) {
    throw new Error(
      `tintClaude: ${tint} leaves the chevron eyes at ${eyes}:1 on the body, under WCAG AA 4.5:1`,
    )
  }
  if (hem < 3) {
    throw new Error(`tintClaude: ${tint} leaves the hem at ${hem}:1 on ${DARK_SURFACE}, under 3:1`)
  }
  const identity = recolour(svgText, CLAUDE_ANCHOR)
  if (identity !== svgText) {
    throw new Error('tintClaude: tinting with the anchor did not reproduce the input byte for byte')
  }
  const out = recolour(svgText, tint)
  /*
   * Same reason as Codex: the locked ids are fixed names and the mark is inlined, so a second
   * Claude Boo in another colour would take the first one's gradients. The anchor returns the
   * locked drawing and keeps the locked ids.
   */
  return out === svgText ? out : namespaceIds(out, tint)
}
