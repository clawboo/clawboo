/**
 * features/onboarding/ProviderIcon.tsx
 *
 * Authentic provider brand marks — every provider renders its REAL mark, no
 * lettermark placeholders. Marks come from two MIT-licensed sources:
 *
 *  - `simple-icons` (installed package) for the brands it carries.
 *  - `@/lib/brandPaths` — path data embedded from the MIT lobe-icons static set
 *    for brands simple-icons does not carry (OpenAI, Groq, Together, Cerebras,
 *    Venice, and Grok for xAI).
 *
 * All marks are single-color by design and meant to be tinted, so we recolor
 * each to a brand accent that reads on BOTH themes — monochrome brands (Ollama,
 * xAI) use `currentColor` so they pick up the theme foreground (white on dark,
 * ink on light). Each mark sits inside a rounded tile washed with a 14% tint of
 * its own accent, matching the premium "integration tile" pattern.
 */
import {
  siAnthropic,
  siGooglegemini,
  siHuggingface,
  siMinimax,
  siMistralai,
  siMoonshotai,
  siNvidia,
  siOllama,
  siOpenrouter,
} from 'simple-icons'

import {
  cerebrasMark,
  groqMark,
  grokMark,
  openaiMark,
  togetherMark,
  veniceMark,
  type BrandGlyph,
} from '@/lib/brandPaths'

export type ProviderId =
  | 'anthropic'
  | 'openai'
  | 'google'
  | 'ollama'
  | 'openrouter'
  | 'xai'
  | 'groq'
  | 'mistral'
  | 'moonshot'
  | 'minimax'
  | 'together'
  | 'nvidia'
  | 'huggingface'
  | 'cerebras'
  | 'venice'

interface BrandMark {
  /**
   * Accent color for the glyph + tile tint. `currentColor` = theme foreground —
   * used for monochrome brands so the mark stays high-contrast in both themes.
   */
  color: string
  /** Official single-path mark (simple-icons), tinted to `color`. */
  icon?: { path: string }
  /** Embedded multi-path mark (lobe-icons / in-repo), tinted to `color`. */
  glyph?: BrandGlyph
  /** Lettermark of last resort — currently unused; kept for future providers. */
  monogram?: string
}

export const PROVIDER_BRAND: Record<ProviderId, BrandMark> = {
  // ── Primary ──
  anthropic: { color: '#D97757', icon: siAnthropic },
  // OpenAI's current brand mark is monochrome (they moved off the teal) — render
  // it in the theme foreground like the other monochrome brands (Ollama, xAI).
  openai: { color: 'currentColor', glyph: openaiMark },
  google: { color: '#4796E3', icon: siGooglegemini },
  ollama: { color: 'currentColor', icon: siOllama },
  // ── More ──
  openrouter: { color: '#8B95FF', icon: siOpenrouter },
  xai: { color: 'currentColor', glyph: grokMark },
  groq: { color: '#F55036', glyph: groqMark },
  mistral: { color: '#FA520F', icon: siMistralai },
  moonshot: { color: '#6366F1', icon: siMoonshotai },
  minimax: { color: '#E73562', icon: siMinimax },
  together: { color: '#14B8A6', glyph: togetherMark },
  nvidia: { color: '#76B900', icon: siNvidia },
  huggingface: { color: '#FFB000', icon: siHuggingface },
  cerebras: { color: '#F4511E', glyph: cerebrasMark },
  venice: { color: '#B45CFF', glyph: veniceMark },
}

/**
 * Just the provider brand MARK (SVG paths or monogram), rendered in
 * `currentColor` with NO surrounding tile — for contexts that supply their own
 * container (e.g. the model orbital node in the Ghost Graph, which draws its own
 * circle). The consumer sets `color` on an ancestor.
 */
export function ProviderGlyph({ id, size }: { id: ProviderId; size: number }) {
  const brand = PROVIDER_BRAND[id]
  if (brand.glyph) {
    return (
      <svg
        width={size}
        height={size}
        viewBox={brand.glyph.viewBox ?? '0 0 24 24'}
        fill="currentColor"
        fillRule="evenodd"
        clipRule="evenodd"
        role="img"
        aria-hidden
      >
        {brand.glyph.paths.map((d, i) => (
          <path key={i} d={d} />
        ))}
        {brand.glyph.strokePaths?.map((d, i) => (
          <path
            key={`s${i}`}
            d={d}
            fill="none"
            stroke="currentColor"
            strokeWidth={brand.glyph!.strokeWidth ?? 2.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        ))}
      </svg>
    )
  }
  if (brand.icon) {
    return (
      <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor" role="img" aria-hidden>
        <path d={brand.icon.path} />
      </svg>
    )
  }
  return (
    <span
      style={{ fontFamily: 'var(--font-display)', fontWeight: 700, fontSize: Math.round(size * 0.85), lineHeight: 1 }}
    >
      {brand.monogram}
    </span>
  )
}

export interface ProviderIconProps {
  id: ProviderId
  /** Tile edge length in px. Glyph scales to ~60% of this. */
  size?: number
}

export function ProviderIcon({ id, size = 22 }: ProviderIconProps) {
  const brand = PROVIDER_BRAND[id]

  return (
    <span
      aria-hidden
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.3),
        color: brand.color,
        // currentColor resolves to the tile's own `color` above, so the wash is
        // always a faint tint of the brand accent (or foreground for monochrome).
        background: 'color-mix(in srgb, currentColor 14%, transparent)',
        flexShrink: 0,
      }}
    >
      <ProviderGlyph id={id} size={Math.round(size * 0.6)} />
    </span>
  )
}
