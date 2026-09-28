/**
 * Recolours the locked Codex Boo from one hex.
 *
 * Every identity colour moves by the OKLCH offset that takes the variant's anchor to the tint, so
 * the five stop body ramp keeps its own lightness spread and hue drift, the foot shade stays a
 * shade and the paws stay lighter than the body. The anchor is the middle stop of
 * codexBodyGradient, so feeding the anchor back in reproduces the locked file byte for byte, which
 * `tintCodex` asserts before it returns anything.
 *
 * Left alone: the eyes, the pure white specular gloss (white has no chroma to carry a hue) and the
 * black ground shadow. The eye group includes one #5E86FF sub catchlight, kept locked with the rest
 * of the eye; see the note above EXEMPT_HEX.
 */
import { CODEX_ANCHOR } from '../meta'
import { contrast, fromOklch, shift, toOklch } from '../colour'
import { namespaceIds } from './ids'

/**
 * Gradients whose stops are identity colours. codexGloss and codexEyeGradient are absent on
 * purpose: specular white and the eye near blacks do not follow the tint.
 */
const TINTED_DEFS = new Set(['codexBodyGradient', 'codexRimGloss', 'codexFoot', 'codexPawGradient'])

/*
 * Colours the tint is allowed to leave where they are. Everything else in the file must move,
 * which assertCoverage checks with a probe tint.
 *   #FFFFFF          gloss stops, eye catchlights, and the glyph stroke when it is not flipped
 *   #000000          ground shadow
 *   #202846 #121827  codexEyeGradient
 *   #5E86FF          the eye's sub catchlight, a 1.05 unit dot inside each pupil (about 2.3px at
 *                    128px, visible when zoomed). It reads as a reflection of the body, so on a
 *                    warm tint each eye carries a cool blue speck. Held locked with the rest of the
 *                    eye, per the brief. To make it follow the tint instead, replace it in the
 *                    codex-eyes branch of recolour with shift('#5E86FF', CODEX_ANCHOR, tint) and
 *                    drop it from this set. The anchor round trip survives either way, because
 *                    shift is the identity at the anchor.
 */
const EXEMPT_HEX = new Set(['#FFFFFF', '#000000', '#202846', '#121827', '#5E86FF'])

/*
 * ---------- what the glyph actually sits on ----------
 * The >_ is drawn over the body between y=54 and y=66 with a 4.8 wide round capped stroke, so its
 * ink spans y 51.6..68.4. Two paints stack there: codexBodyGradient, mapped in user space from
 * y=-8 to y=78, and codexFoot, a shade of the body ramp fading in from y=54 to y=80 at up to 0.3
 * alpha. No gloss reaches this low: the lowest gloss, codexRimGloss at cy=22 ry=14, ends at y=36.
 *
 * The default sample point is the ink centroid. The chevron is 20.3 units of stroke spread evenly
 * over y 54..66 (mean y 60) and the underscore is 13.6 units at y=66, which puts the centroid at
 * y=62.4. A render of the locked file agrees with this model to within two levels per channel.
 * Backdrop is x invariant to within one level, so one y is the whole model.
 */
const GLYPH_CENTROID_Y = 62.41
const GLYPH_TOP_Y = 51.6
const GLYPH_BOTTOM_Y = 68.4

const RAMP: [number, string][] = [
  [0, '#A9A9F8'],
  [0.25, '#95A8FD'],
  [0.5, '#7B95FC'],
  [0.75, '#6480FD'],
  [1, '#4355FA'],
]
const FOOT = '#3244F2'

const channels = (hex: string): number[] => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16))

const toHex = (parts: number[]): string =>
  '#' +
  parts
    .map((x) =>
      Math.round(Math.max(0, Math.min(255, x)))
        .toString(16)
        .padStart(2, '0')
        .toUpperCase(),
    )
    .join('')

const mix = (a: string, b: string, t: number): string => {
  const to = channels(b)
  return toHex(channels(a).map((v, i) => v + (to[i] - v) * t))
}

const at = (stops: [number, string][], t: number): string => {
  const clamped = Math.max(0, Math.min(1, t))
  for (let i = 1; i < stops.length; i++) {
    const [p1, c1] = stops[i]
    if (clamped <= p1) {
      const [p0, c0] = stops[i - 1]
      return mix(c0, c1, (clamped - p0) / (p1 - p0))
    }
  }
  return stops[stops.length - 1][1]
}

const over = (fg: string, alpha: number, bg: string): string => {
  const under = channels(bg)
  return toHex(channels(fg).map((v, i) => v * alpha + under[i] * (1 - alpha)))
}

/** The composited body colour under the glyph's ink at `y`, for a given tint. */
export function glyphBackdrop(tint: string, y: number = GLYPH_CENTROID_Y): string {
  const body = at(
    RAMP.map(([p, c]) => [p, shift(c, CODEX_ANCHOR, tint)] as [number, string]),
    (y + 8) / 86,
  )
  const footAlpha = Math.max(0, Math.min(1, (y - 54) / 26)) * 0.3
  return over(shift(FOOT, CODEX_ANCHOR, tint), footAlpha, body)
}

/*
 * ---------- the glyph ink ----------
 * White reads on the locked blue and on every deep tint, and goes faint on the light ones. The
 * replacement is a very dark shade of the tint rather than black, so the mark stays one family:
 * the tint's own hue, chroma held back to a deep ink, lightness dropped to INK_L.
 *
 * INK_L has a measured window. Below about L 0.193 the dark ink clears 4.5 on the locked blue too,
 * which would flip a glyph the locked file draws white; above about L 0.205 the weakest teammate
 * tint (#A78BFA) no longer clears 4.5 and would be left with a white mark its body cannot carry.
 * Measured in 0.001 steps, every L from 0.194 to 0.204 satisfies both, and 0.20 sits in the middle
 * of that window: the anchor's dark ink reaches 4.43, under the target, and the weakest teammate's
 * reaches 4.54, over it.
 *
 * The flip needs both halves: white has to fall under 4.5 AND the dark ink has to clear it.
 */
const INK_L = 0.2
const INK_MAX_C = 0.09
const TARGET = 4.5

export interface GlyphInk {
  backdrop: string
  white: number
  dark: string
  darkContrast: number
  whiteMin: number
  darkMin: number
  flip: boolean
  ink: string
}

export function glyphInk(tint: string): GlyphInk {
  const backdrop = glyphBackdrop(tint)
  const t = toOklch(tint)
  const dark = fromOklch({ L: INK_L, C: Math.min(t.C, INK_MAX_C), H: t.H })
  const white = contrast('#FFFFFF', backdrop)
  const flip = white < TARGET && contrast(dark, backdrop) >= TARGET
  return {
    backdrop,
    white,
    dark,
    darkContrast: contrast(dark, backdrop),
    // The centroid is not the worst point. The ramp runs light to dark down the mark, so white is
    // faintest at the top of the ink and the dark ink is faintest at the bottom. The flip gate
    // stays on the centroid, which is what the lock was measured against; these two are reported
    // so nobody quotes a centroid number for a mark whose faintest point is lower.
    whiteMin: contrast('#FFFFFF', glyphBackdrop(tint, GLYPH_TOP_Y)),
    darkMin: contrast(dark, glyphBackdrop(tint, GLYPH_BOTTOM_Y)),
    flip,
    ink: flip ? dark : '#FFFFFF',
  }
}

/*
 * ---------- the transform ----------
 * A line scan rather than a global search and replace, because #FFFFFF means three different
 * things in this file: the gloss stops, the eye catchlights and the glyph stroke.
 */
function recolour(svgText: string, tint: string): string {
  const ink = glyphInk(tint).ink
  let def: string | null = null
  const stack: string[] = []
  return svgText
    .split('\n')
    .map((line) => {
      const open = line.match(/<(?:linear|radial)Gradient id="([^"]+)"/)
      if (open) def = open[1]
      const group = line.match(/<g id="([^"]+)"/)
      if (group) stack.push(group[1])
      const here = stack[stack.length - 1]

      let out = line
      if (def && TINTED_DEFS.has(def)) {
        out = line.replace(/#[0-9A-Fa-f]{6}/g, (c) => shift(c.toUpperCase(), CODEX_ANCHOR, tint))
      } else if (here === 'codex-terminal-glyph') {
        out = line.replace(/stroke="#[0-9A-Fa-f]{6}"/g, `stroke="${ink}"`)
      }

      if (/<\/(?:linear|radial)Gradient>/.test(line)) def = null
      if (/<\/g>/.test(line)) stack.pop()
      return out
    })
    .join('\n')
}

const hexes = (s: string): string[] =>
  [...s.matchAll(/#[0-9A-Fa-f]{6}\b/g)].map((m) => m[0].toUpperCase())

/*
 * The anchor round trip only catches over-tinting: shift(c, anchor, anchor) is the identity for
 * every colour, so a colour that ought to move but is not covered by TINTED_DEFS survives it
 * silently. This catches under-tinting from the other side: tint with a probe far from the anchor
 * and require every hex outside EXEMPT_HEX to have moved.
 */
const PROBE = '#00FF00'

function assertCoverage(svgText: string): void {
  const before = hexes(svgText)
  const after = hexes(recolour(svgText, PROBE))
  if (before.length !== after.length) {
    throw new Error(
      'tintCodex: tinting changed how many colours the file has, which it must never do',
    )
  }
  const stuck = before.filter((c, i) => c === after[i] && !EXEMPT_HEX.has(c))
  if (stuck.length) {
    throw new Error(
      `tintCodex: ${[...new Set(stuck)].join(', ')} did not move under a probe tint, so a colour ` +
        'this file paints is not covered by TINTED_DEFS',
    )
  }
}

let anchorChecked = false

/**
 * Recolour a codex-boo SVG to `tint`.
 *
 * `svgText` is the locked artwork, so the two guards below run against the lock itself: the anchor
 * round trip catches a colour that moved when it should not have, and assertCoverage catches one
 * that stayed put when it should have moved.
 */
export function tintCodex(svgText: string, tint: string): string {
  if (!/^#[0-9A-Fa-f]{6}$/.test(tint)) {
    throw new Error(`tintCodex: expected a #rrggbb tint, got ${tint}`)
  }
  if (!anchorChecked) {
    if (glyphInk(CODEX_ANCHOR).flip) {
      throw new Error(
        'tintCodex: the anchor would flip the glyph ink, which the locked file draws white',
      )
    }
    anchorChecked = true
  }
  if (recolour(svgText, CODEX_ANCHOR) !== svgText) {
    throw new Error(
      'tintCodex: this SVG does not survive its own anchor, so its colours are not the ones this ' +
        'tinter was written against',
    )
  }
  assertCoverage(svgText)
  const out = recolour(svgText, tint)
  /*
   * The locked file's ids are fixed names, and a variant is inlined into the page, so two Codex
   * Boos in different colours would both resolve `url(#codexBodyGradient)` to whichever mounted
   * first. A tint that did not move the artwork is the anchor, whose drawing is the locked one, and
   * identical drawings cannot repaint each other, so it keeps the locked ids.
   */
  return out === svgText ? out : namespaceIds(out, tint)
}
