/**
 * Generative Boo team-color palettes.
 *
 * A team picks a *collection* (not individual colors). Each of its N Boos then
 * gets a distinct color generated in OKLCH: the 360° hue wheel is divided into
 * N even steps from the collection's hue offset, lightness is staggered
 * (Okabe-Ito) so the team reads as distinct even in grayscale / under CVD, the
 * lightness band is chosen per theme so colors never wash out, and every color
 * is gamut-mapped to sRGB (chroma reduced, hue + lightness preserved).
 *
 * The recipe numbers (chroma, light/dark lightness, stagger) are authoritative —
 * do not re-derive them. Hue offsets are aesthetic tuning; steps stay even.
 */

import { clampChroma, formatHex } from 'culori'
import { TINTS } from '@clawboo/ui'

export type CollectionId =
  | 'vivid-pop'
  | 'dusty-pastel-pro'
  | 'coastal-mist'
  | 'executive-jewel'
  | 'sharp-saas'
  | 'soft-neutral-editorial'
  | 'monochrome-accent'
  | 'classic'

export interface PaletteRecipe {
  id: CollectionId
  name: string
  description: string
  /** OKLCH chroma for the base (non-accent) colors. */
  chroma: number
  /** OKLCH lightness anchor on a LIGHT UI background. */
  lightnessLight: number
  /** OKLCH lightness anchor on a DARK UI background. */
  lightnessDark: number
  /** Hue (degrees) of the first Boo; subsequent Boos step evenly from here. */
  hueOffset: number
  /** ±L applied alternately to even/odd Boos for grayscale/CVD separation. */
  stagger: number
  /**
   * Monochrome-style collections only: most slots use the (very low) base
   * `chroma`, while a few spread-out "accent" slots get this higher chroma so
   * the team reads as near-grayscale with one or two color pops.
   */
  accent?: { chroma: number; slots: number }
  /**
   * Legacy pixel-exact palette. When present, colors come VERBATIM from this
   * list (theme-independent) instead of the OKLCH recipe — the chroma /
   * lightness / hue fields are ignored. Used by the `classic` collection to
   * reproduce the original tint set exactly.
   */
  fixedColors?: readonly string[]
}

export const PALETTE_RECIPES: Record<CollectionId, PaletteRecipe> = {
  'vivid-pop': {
    id: 'vivid-pop',
    name: 'Vivid Pop',
    description: 'Bright, punchy colors. Playful and lively.',
    // High chroma so mascot fills stay alive on a bright canvas — the
    // generative successor to the original vivid tint set.
    chroma: 0.15,
    lightnessLight: 0.62,
    lightnessDark: 0.7,
    hueOffset: 25,
    stagger: 0.05,
  },
  'dusty-pastel-pro': {
    id: 'dusty-pastel-pro',
    name: 'Dusty Pastel Pro',
    description: 'Muted, sophisticated pastels. Calm and professional.',
    chroma: 0.066,
    lightnessLight: 0.63,
    lightnessDark: 0.7,
    hueOffset: 25,
    stagger: 0.05,
  },
  'coastal-mist': {
    id: 'coastal-mist',
    name: 'Coastal Mist',
    description: 'Airy, light seaside tones. Soft and breezy.',
    chroma: 0.042,
    lightnessLight: 0.76,
    lightnessDark: 0.84,
    hueOffset: 235,
    stagger: 0.05,
  },
  'executive-jewel': {
    id: 'executive-jewel',
    name: 'Executive Jewel',
    description: 'Deep, rich jewel tones. Bold and premium.',
    chroma: 0.089,
    lightnessLight: 0.46,
    lightnessDark: 0.54,
    hueOffset: 15,
    stagger: 0.05,
  },
  'sharp-saas': {
    id: 'sharp-saas',
    name: 'Sharp SaaS',
    description: 'Vivid, saturated product colors. Crisp and modern.',
    chroma: 0.13,
    lightnessLight: 0.57,
    lightnessDark: 0.63,
    hueOffset: 10,
    stagger: 0.04,
  },
  'soft-neutral-editorial': {
    id: 'soft-neutral-editorial',
    name: 'Soft Neutral Editorial',
    description: 'Quiet, warm neutrals. Understated and elegant.',
    chroma: 0.042,
    lightnessLight: 0.7,
    lightnessDark: 0.78,
    hueOffset: 30,
    // Lowest-contrast set — widen the stagger so Boos still separate.
    stagger: 0.08,
  },
  'monochrome-accent': {
    id: 'monochrome-accent',
    name: 'Monochrome Accent',
    description: 'Near-grayscale with one or two color pops.',
    chroma: 0.01,
    lightnessLight: 0.65,
    lightnessDark: 0.72,
    hueOffset: 25,
    stagger: 0.06,
    accent: { chroma: 0.06, slots: 2 },
  },
  classic: {
    id: 'classic',
    name: 'Classic',
    description: 'The original vivid tints — pixel-exact, legacy per-Boo colors.',
    // Fixed legacy palette: the pre-collections tint set minus the
    // Boo-Zero-reserved red (TINTS[0]). The OKLCH fields below are unused
    // (fixedColors wins). The per-Boo resolver ALSO reuses the original hash
    // assignment for this collection, so every Boo keeps its exact old color.
    chroma: 0.15,
    lightnessLight: 0.62,
    lightnessDark: 0.7,
    hueOffset: 25,
    stagger: 0.05,
    fixedColors: TINTS.slice(1),
  },
}

// Classic is the default: the original tint set, pixel-exact and using the
// legacy per-agent hash assignment, so out of the box every Boo looks exactly
// as it did before collections existed. Generative collections are opt-in.
export const DEFAULT_COLLECTION_ID: CollectionId = 'classic'

// The default collection leads the picker; the rest follow declared order.
export const COLLECTION_IDS: CollectionId[] = [
  DEFAULT_COLLECTION_ID,
  ...(Object.keys(PALETTE_RECIPES) as CollectionId[]).filter((id) => id !== DEFAULT_COLLECTION_ID),
]

/** Lightness band Boos are kept inside, so extremes never wash out / crush. */
const L_MIN = 0.1
const L_MAX = 0.95
/** Minimum OKLab ΔE between two adjacent Boos before we nudge one apart. */
const MIN_DELTA_E = 0.05

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v
}

/** Spread `slots` accent indices evenly across `count` positions. */
function accentIndices(count: number, slots: number): Set<number> {
  const out = new Set<number>()
  const n = Math.min(slots, count)
  for (let k = 0; k < n; k++) out.add(Math.floor((k * count) / n))
  return out
}

/** Perceptual distance in OKLab between two OKLCH points. */
function oklabDistance(a: OklchPoint, b: OklchPoint): number {
  const ah = (a.h * Math.PI) / 180
  const bh = (b.h * Math.PI) / 180
  const da = a.c * Math.cos(ah) - b.c * Math.cos(bh)
  const db = a.c * Math.sin(ah) - b.c * Math.sin(bh)
  const dl = a.l - b.l
  return Math.sqrt(dl * dl + da * da + db * db)
}

interface OklchPoint {
  l: number
  c: number
  h: number
}

function toHex(p: OklchPoint): string {
  // clampChroma reduces chroma until the color fits sRGB, preserving L and H —
  // the CSS Color 4 gamut-mapping strategy. formatHex then emits #rrggbb.
  const inGamut = clampChroma({ mode: 'oklch', l: p.l, c: p.c, h: p.h }, 'oklch')
  return formatHex(inGamut) ?? '#000000'
}

/**
 * Deterministic hue rotation (0–359°) from a seed string (a team id). Lets two
 * teams that picked the SAME collection — and even the same member count — land
 * on a DIFFERENT slice of the hue wheel, so their Boos don't look identical.
 * FNV-1a over the seed; empty seed → no rotation (the recipe's own hueOffset).
 * The rotation only shifts WHICH hues appear — chroma + lightness (the palette's
 * "feel") are untouched, so a team still reads as its chosen collection.
 */
export function hueRotationFromSeed(seed: string): number {
  if (!seed) return 0
  let h = 0x811c9dc5
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0) % 360
}

/**
 * Generate `count` distinct hex colors for a team, from `collectionId`,
 * adapted to the active `theme`. Hues are evenly spaced around the wheel
 * (starting from the recipe's offset plus an optional per-team `hueRotation`),
 * lightness is staggered, adjacent collisions are nudged apart, and every
 * result is gamut-mapped to sRGB.
 */
export function generateTeamColors(
  collectionId: CollectionId,
  count: number,
  theme: 'light' | 'dark',
  hueRotation = 0,
): string[] {
  if (count <= 0) return []
  const recipe = PALETTE_RECIPES[collectionId] ?? PALETTE_RECIPES[DEFAULT_COLLECTION_ID]
  // Legacy fixed palette (e.g. Classic): cycle the literal list verbatim,
  // theme-independent — exactly how the original tints behaved. The per-team
  // rotation does NOT apply (the list is pixel-exact by contract).
  if (recipe.fixedColors && recipe.fixedColors.length > 0) {
    const fixed = recipe.fixedColors
    return Array.from({ length: count }, (_, i) => fixed[i % fixed.length])
  }
  const baseL = theme === 'dark' ? recipe.lightnessDark : recipe.lightnessLight
  const hueStep = 360 / count
  const accents = recipe.accent ? accentIndices(count, recipe.accent.slots) : null

  const points: OklchPoint[] = []
  for (let i = 0; i < count; i++) {
    const h = (recipe.hueOffset + hueRotation + i * hueStep) % 360
    // Okabe-Ito: even Boos lighter, odd Boos darker.
    const staggered = baseL + (i % 2 === 0 ? recipe.stagger : -recipe.stagger)
    const l = clamp(staggered, L_MIN, L_MAX)
    const c = accents?.has(i) && recipe.accent ? recipe.accent.chroma : recipe.chroma
    points.push({ l, c, h })
  }

  // Min-distance pass over wheel-adjacent pairs (including the wrap pair, which
  // is where odd-N collapses: indices 0 and N-1 are both even → same L).
  if (count > 1) {
    for (let i = 0; i < count; i++) {
      const j = (i + 1) % count
      if (i === j) continue
      if (oklabDistance(points[i], points[j]) < MIN_DELTA_E) {
        const dir = points[j].l >= points[i].l ? 1 : -1
        points[j].l = clamp(points[j].l + dir * MIN_DELTA_E, L_MIN, L_MAX)
      }
    }
  }

  return points.map(toHex)
}

/**
 * A stable, theme-independent representative hex for a collection — used as the
 * team's `color` chrome field (icon-bg tint, halo, accent button). Fixed to a
 * mid lightness so a solid-fill button with light text stays legible regardless
 * of the collection's pastel/jewel character; the per-Boo palette is the
 * theme-adaptive part.
 */
export function collectionAnchorColor(collectionId: CollectionId): string {
  const recipe = PALETTE_RECIPES[collectionId] ?? PALETTE_RECIPES[DEFAULT_COLLECTION_ID]
  if (recipe.fixedColors && recipe.fixedColors.length > 0) return recipe.fixedColors[0]
  const chroma = recipe.accent ? recipe.accent.chroma : recipe.chroma
  return toHex({ l: 0.5, c: chroma, h: recipe.hueOffset })
}
