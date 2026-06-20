/**
 * features/runtimes/RuntimeBrand.tsx
 *
 * Brand marks for the non-OpenClaw coding-agent runtimes (Claude Code / Codex /
 * Hermes), mirroring `features/onboarding/ProviderIcon.tsx` exactly (same 14%
 * color-mix tile, same glyph sizing, same lettermark fallback) so the runtime
 * cards read as peers of the provider cards.
 *
 * Deliberately a sibling of ProviderIcon rather than widening its `ProviderId`
 * union — runtimes are not OpenClaw model providers, and that union is consumed
 * by the model picker / configure step.
 *
 * Mark choices (validated against simple-icons v16):
 *  - claude-code → `siClaude` (the sanctioned Claude mark).
 *  - codex → a `C` lettermark in OpenAI green. simple-icons carries no clean
 *    OpenAI/Codex mark, so an original lettermark (not a reproduction) is used —
 *    same approach ProviderIcon takes for OpenAI.
 *  - hermes → an `H` lettermark. simple-icons' `siHermes` is a DIFFERENT brand
 *    (not the hermes-agent CLI), so using it would misattribute a logo; a
 *    lettermark is the honest choice. (The card represents the Hermes runtime,
 *    not its OpenRouter provider.)
 *  - clawboo-native → an `N` lettermark in the mint accent family (clawboo's
 *    own built-in runtime — no third-party brand to attribute).
 *
 * Brand hex is confined to this map — the documented design-system exception for
 * brand marks; all card chrome derives from theme tokens via color-mix.
 */
import { siClaude } from 'simple-icons'

import type { RuntimeId } from './runtimeCatalog'

interface RuntimeBrandMark {
  color: string
  icon?: { path: string }
  monogram?: string
}

export const RUNTIME_BRAND: Record<RuntimeId, RuntimeBrandMark> = {
  'clawboo-native': { color: '#34D399', monogram: 'N' },
  'claude-code': { color: '#D97757', icon: siClaude },
  codex: { color: '#10A37F', monogram: 'C' },
  hermes: { color: '#8B95FF', monogram: 'H' },
}

export interface RuntimeIconProps {
  id: RuntimeId
  /** Tile edge length in px. Glyph scales to ~60% of this. */
  size?: number
}

export function RuntimeIcon({ id, size = 36 }: RuntimeIconProps) {
  const brand = RUNTIME_BRAND[id]
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
