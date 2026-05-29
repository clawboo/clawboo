/**
 * features/onboarding/ProviderIcon.tsx
 *
 * Authentic provider brand marks for the onboarding "Set Up OpenClaw" step —
 * replaces the previous emoji glyphs (🅰️ 🤖 🔷 …) that read as low-effort craft.
 *
 * Official single-path marks come from `simple-icons` (the sanctioned brand-asset
 * channel; MIT-licensed package). They're single-color by design and meant to be
 * tinted, so we recolor each to a brand accent that reads on BOTH themes —
 * monochrome brands (Ollama, xAI) use `currentColor` so they pick up the theme
 * foreground (white on dark, ink on light). Providers simple-icons doesn't carry
 * (OpenAI, Groq, Moonshot, Together, Cerebras, Venice) render as a clean
 * lettermark tile in the brand accent — an original mark, not a reproduction.
 *
 * Each mark sits inside a rounded tile washed with a 14% tint of its own accent,
 * matching the premium "integration tile" pattern (Linear / Vercel connectors).
 */
import {
  siAnthropic,
  siGooglegemini,
  siHuggingface,
  siMinimax,
  siMistralai,
  siNvidia,
  siOllama,
  siOpenrouter,
} from 'simple-icons'

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
  /** Lettermark fallback when no sanctioned mark exists. */
  monogram?: string
}

export const PROVIDER_BRAND: Record<ProviderId, BrandMark> = {
  // ── Primary ──
  anthropic: { color: '#D97757', icon: siAnthropic },
  openai: { color: '#10A37F', monogram: 'O' },
  google: { color: '#4796E3', icon: siGooglegemini },
  ollama: { color: 'currentColor', icon: siOllama },
  // ── More ──
  openrouter: { color: '#8B95FF', icon: siOpenrouter },
  xai: { color: 'currentColor', monogram: 'X' },
  groq: { color: '#F55036', monogram: 'G' },
  mistral: { color: '#FA520F', icon: siMistralai },
  moonshot: { color: '#6366F1', monogram: 'M' },
  minimax: { color: '#E73562', icon: siMinimax },
  together: { color: '#14B8A6', monogram: 'T' },
  nvidia: { color: '#76B900', icon: siNvidia },
  huggingface: { color: '#FFB000', icon: siHuggingface },
  cerebras: { color: '#F4511E', monogram: 'C' },
  venice: { color: '#B45CFF', monogram: 'V' },
}

export interface ProviderIconProps {
  id: ProviderId
  /** Tile edge length in px. Glyph scales to ~60% of this. */
  size?: number
}

export function ProviderIcon({ id, size = 22 }: ProviderIconProps) {
  const brand = PROVIDER_BRAND[id]
  const glyph = Math.round(size * 0.6)

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
      {brand.icon ? (
        <svg width={glyph} height={glyph} viewBox="0 0 24 24" fill="currentColor" role="img">
          <path d={brand.icon.path} />
        </svg>
      ) : (
        <span
          style={{
            fontFamily: 'var(--font-display)',
            fontWeight: 700,
            fontSize: Math.round(size * 0.5),
            lineHeight: 1,
          }}
        >
          {brand.monogram}
        </span>
      )}
    </span>
  )
}
