/**
 * Tints Hermes Boo from one hex.
 *
 * Hermes is the two-ink variant: #000000 and #FFFFFF, no ramp of its own. The white part of the
 * body takes the colour completely, like any other Boo, and the hair, the eyes and the headset stay
 * black. Colouring the earcups, and colouring the whole headset, were both built and rejected: the
 * black headset framing the black bob against a coloured face is what keeps the mark reading at
 * 64px.
 *
 * THE RAMP. The generated mascot runs its body from the tint down to a darker shade of it. Codex
 * Boo and Claude Boo spread that over five stops, and the two ramps agree closely on the SHAPE of
 * the spread: lightness falls 0.219 in OKLCH from top to bottom, chroma rises to about 1.85x, hue
 * drifts about 13 degrees away from the light end. REFERENCE_RAMP carries the average of those two
 * shapes.
 *
 * WHERE THE TINT LANDS ON IT. Every stop is placed by shift(stop, RAMP_ANCHOR, tint), and
 * RAMP_ANCHOR is the ramp's MIDDLE stop, which is where Codex anchors and where Claude anchors.
 * Anchoring at the top stop instead puts Hermes half a ramp below its siblings, and the hair
 * covering the dome costs another step: rendered side by side at #FBBF24 the siblings are amber and
 * Hermes is burnt orange, at #A78BFA they are lavender and Hermes is blue-violet. That is a
 * different palette entry, not a darker shade of the same one. The middle stop is a deliberate
 * trade: the generated mascot puts the user's hex at the top of its own two stop gradient, and
 * matching the two variants that ship beside Hermes is worth more than matching that literally.
 *
 * THE ROUND TRIP. There is NO anchor round trip here. Hermes's own identity colour is its body ink,
 * #FFFFFF, and white carries no chroma, so a ramp anchored on it collapses to greys: shift() scales
 * chroma by o.C/A.C. Tinting Hermes with #FFFFFF is therefore a documented no-op, an early return
 * to the locked bytes, not evidence that the transform is the identity at its anchor. The genuine
 * assertion is the ramp's own round trip: tinting with RAMP_ANCHOR must give REFERENCE_RAMP back
 * exactly, which assertRampRoundTrip() checks.
 *
 * WHITE MARKS. Every traced layer is one evenodd path whose enclosed subpaths knock holes in the
 * ink: the gloss streaks in the hair, the gloss on the earcups, the catchlights in the eyes. A hole
 * shows whatever is behind it, which is the body, so colouring the body would drag those white
 * marks with it and the eyes would lose their catchlights. Each inked layer therefore gets a white
 * underlay of its own silhouette: the same path filled nonzero, which fills the holes because
 * potrace winds them in the same direction as the outer contour. The underlay is invisible except
 * through the holes.
 *
 * THE DARK FILE. Its two white additions do different jobs. The HALO, a white stroke under every
 * black path, is the mark's edge light on a dark page. It is painted flat at the ramp's top stop,
 * never with the body gradient: a gradient puts the darkest stop at the hem, which is exactly where
 * the rim is carrying the silhouette, and the scallops dissolve into the page. The BACKING, the
 * mark's filled silhouette, stays white, so the crescent between headband and crown reads the same
 * on both surfaces: page coloured on light, white on dark.
 */
import { HERMES_INK } from '../meta'
import { contrast, shift } from '../colour'

const DARK_SURFACE = '#0a0e1a'

/*
 * Five body stops carrying the averaged Codex/Claude ramp shape. The hue and lightness of the
 * reference itself are arbitrary: shift() only reads each stop's offset from RAMP_ANCHOR, which is
 * why any tint reproduces the same shape.
 */
const REFERENCE_RAMP = ['#BCB4F4', '#A8A9F4', '#9499EF', '#8087E8', '#646CDB']
const RAMP_ANCHOR = REFERENCE_RAMP[2]

/*
 * The traced body's own bounding box, so the ramp maps to the body the way the other variants map
 * theirs. The frame is larger than the body: the hair, the headset and the hem all overhang it.
 */
const BODY_TOP = 13.7
const BODY_BOTTOM = 80.5

const ramp = (tint: string): string[] => REFERENCE_RAMP.map((c) => shift(c, RAMP_ANCHOR, tint))

/** The body colour at a given y in Boo units, for measuring contrast against the ink over it. */
export function bodyColourAt(tint: string, y: number): string {
  const stops = ramp(tint)
  const t = Math.max(0, Math.min(1, (y - BODY_TOP) / (BODY_BOTTOM - BODY_TOP))) * 4
  const i = Math.min(3, Math.floor(t))
  const f = t - i
  const channel = (hex: string, k: number): number => parseInt(hex.slice(k, k + 2), 16)
  const mix = (a: string, b: string): string =>
    '#' +
    [1, 3, 5]
      .map((k) =>
        Math.round(channel(a, k) + (channel(b, k) - channel(a, k)) * f)
          .toString(16)
          .padStart(2, '0'),
      )
      .join('')
      .toUpperCase()
  return mix(stops[i], stops[i + 1])
}

/*
 * The dark file's hermes-hair-back nests a group of its own, so the first </g> after the open tag
 * is the inner one. Count nesting, or an edit that has to reach past the halo silently no-ops.
 */
function findGroup(svg: string, id: string): { start: number; end: number } | null {
  const tag = `<g id="${id}">`
  const open = svg.indexOf(tag)
  if (open < 0) return null
  let i = open + tag.length
  let depth = 1
  for (;;) {
    const nextOpen = svg.indexOf('<g', i)
    const nextClose = svg.indexOf('</g>', i)
    if (nextClose < 0) return null
    if (nextOpen >= 0 && nextOpen < nextClose) {
      const gt = svg.indexOf('>', nextOpen)
      if (svg[gt - 1] !== '/') depth++
      i = gt + 1
      continue
    }
    if (--depth === 0) return { start: open + tag.length, end: nextClose }
    i = nextClose + 4
  }
}

function editGroup(svg: string, id: string, fn: (inner: string) => string): string {
  const g = findGroup(svg, id)
  if (!g) return svg
  return svg.slice(0, g.start) + fn(svg.slice(g.start, g.end)) + svg.slice(g.end)
}

/** The ink element of a layer: a <path> in the light file, a <use> in the dark one. */
const INK_RE = /^([^\S\n]*)(<(?:path|use)[^>]*fill="#000000"[^>]*\/>)$/m

interface Paint {
  fill: string
  rule: string
  clip?: string
}

let rampChecked = false

/**
 * Recolour a locked Hermes SVG from one tint.
 *
 * `svgText` is hermes-boo.svg or hermes-boo-dark.svg, verbatim; the transform reads which one it
 * was given from the shape of the hair-back layer.
 */
export function tintHermes(svgText: string, tintHex: string): string {
  const tint = tintHex.toUpperCase()
  if (!/^#[0-9A-F]{6}$/.test(tint)) throw new Error(`tint must be #RRGGBB, got ${tintHex}`)
  // Hermes's body ink IS white, so tinting with it cannot change anything. Documented no-op.
  if (tint === HERMES_INK) return svgText
  if (!rampChecked) {
    assertRampRoundTrip()
    rampChecked = true
  }

  const stops = ramp(tint)
  assertDarkSurface(tint)
  const dark = svgText.includes('<g id="hermes-hair-back">\n    <path')
  let svg = svgText

  /*
   * Minted ids carry the tint, so two differently tinted Hermes Boos inlined in one document do not
   * both resolve to whichever gradient came first.
   */
  const uid = (s: string): string => `hermesTint${tint.slice(1)}${s}`

  /*
   * Each inked layer is drawn two or three times, so its geometry moves into <defs> and the layer
   * becomes <use> elements. The dark file already does this and keeps its own ids; the light file's
   * paths are hoisted here, which keeps a tinted file the same size as the locked one.
   */
  const hoisted: string[] = []
  const layer = (groupId: string, name: string, paints: Paint[]): void => {
    svg = editGroup(svg, groupId, (g) =>
      g.replace(INK_RE, (_, pad: string, el: string) => {
        let ref = el.match(/href="#([^"]+)"/)?.[1]
        if (!ref) {
          ref = uid(name)
          const d = el.match(/ d="([^"]+)"/)
          if (!d) throw new Error(`tintHermes: the ${groupId} ink has no d attribute to hoist`)
          hoisted.push(`    <path id="${ref}" d="${d[1]}"/>`)
        }
        return paints
          .map((p) => {
            const use = `<use href="#${ref}" fill="${p.fill}" fill-rule="${p.rule}"/>`
            return pad + (p.clip ? `<g clip-path="url(#${p.clip})">${use}</g>` : use)
          })
          .join('\n')
      }),
    )
  }
  // A white underlay first, so the holes the evenodd ink knocks out stay white, then the ink.
  const WHITE: Paint = { fill: '#FFFFFF', rule: 'nonzero' }
  const BLACK: Paint = { fill: '#000000', rule: 'evenodd' }
  layer('hermes-bangs', 'Hair', [WHITE, BLACK])
  layer('hermes-face', 'Eyes', [WHITE, BLACK])
  layer('hermes-headphones', 'Headset', [WHITE, BLACK])

  const defs = [
    `    <linearGradient id="${uid('Body')}" gradientUnits="userSpaceOnUse" x1="50" y1="${BODY_TOP}" x2="50" y2="${BODY_BOTTOM}">`,
    ...stops.map((c, i) => `      <stop offset="${i * 25}%" stop-color="${c}"/>`),
    `    </linearGradient>`,
    ...hoisted,
  ].join('\n')
  svg = svg.includes('<defs>')
    ? svg.replace('  <defs>\n', `  <defs>\n${defs}\n`)
    : svg.replace(/( {2}-->\n)/, `$1  <defs>\n${defs}\n  </defs>\n`)

  svg = editGroup(svg, 'boo-base', (g) =>
    g.replace('fill="#FFFFFF"', `fill="url(#${uid('Body')})"`),
  )

  // The halo is the mark's edge light on a dark page. Flat at the top stop: under the body gradient
  // the hem rim takes the darkest stop, and the scallops stop reading against #0a0e1a.
  svg = editGroup(svg, 'hermes-hair-back', (g) =>
    dark ? g.replace('stroke="#FFFFFF"', `stroke="${stops[0]}"`) : g,
  )

  return svg
}

/*
 * The hem stop carries the silhouette on a dark page, so a deep tint can sink into #0a0e1a. The
 * Claude tinter refuses such a tint outright; this does the same.
 */
export function darkSurfaceContrast(tint: string): { hem: number } {
  return { hem: contrast(ramp(tint)[4], DARK_SURFACE) }
}

/** Whether a tint keeps the hem readable on a dark page. See `nearestLegible`. */
export function hermesLegibility(tintHex: string): { ok: boolean; hem: number } {
  const { hem } = darkSurfaceContrast(tintHex.toUpperCase())
  return { ok: hem >= 3, hem }
}

function assertDarkSurface(tint: string): void {
  const { hem } = darkSurfaceContrast(tint)
  if (hem < 3) {
    throw new Error(
      `tintHermes: ${tint} leaves the hem stop at ${hem}:1 on ${DARK_SURFACE}, under 3:1`,
    )
  }
}

/**
 * The ramp's own round trip, which is the whole guard: RAMP_ANCHOR must rebuild REFERENCE_RAMP
 * exactly, so every other tint carries the reference shape and nothing else.
 */
export function assertRampRoundTrip(): void {
  const back = ramp(RAMP_ANCHOR).join(' ')
  if (back !== REFERENCE_RAMP.join(' ')) throw new Error(`ramp round trip drifted: ${back}`)
}

/*
 * Where the ink actually touches the body, which is what the contrast is measured at, not where the
 * ink is centred. The side lock's lowest tip reaches y=65.2 and the eye ink's lowest point y=48.6;
 * both sit lower than their centroids, and the gradient is darkest at the bottom, so sampling the
 * centroid reports about 0.5 too much. Per pixel minima on 512px renders agree with these heights
 * to within 0.1 across all nine teammate tints.
 */
const HAIR_LOW_Y = 65.2
const EYE_LOW_Y = 48.6

/** Contrast of the ink that carries the mark against the body colour behind it. */
export function inkContrast(tint: string): { hair: number; eyes: number } {
  const hair = Math.min(
    contrast('#000000', bodyColourAt(tint, 30)),
    contrast('#000000', bodyColourAt(tint, HAIR_LOW_Y)),
  )
  const eyes = contrast('#000000', bodyColourAt(tint, EYE_LOW_Y))
  return { hair, eyes }
}
