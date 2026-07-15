/**
 * features/runtimes/RuntimeBrand.tsx
 *
 * Brand marks for the coding-agent runtimes (Clawboo Native / Claude Code /
 * Codex / Hermes) + the OpenClaw tile, mirroring
 * `features/onboarding/ProviderIcon.tsx` exactly (same 14% color-mix tile, same
 * glyph sizing) so the runtime tiles read as peers of the provider tiles.
 *
 * Deliberately a sibling of ProviderIcon rather than widening its `ProviderId`
 * union — runtimes are not OpenClaw model providers, and that union is consumed
 * by the model picker / configure step.
 *
 * Mark choices — every runtime renders its REAL mark:
 *  - claude-code → the dedicated Claude Code mark (lobe-icons `claudecode`, MIT).
 *  - codex → the OpenAI Codex mark (lobe-icons `codex`, MIT).
 *  - hermes → the hermes-agent CLI's own mark (lobe-icons `hermesagent`, MIT).
 *    NEVER simple-icons' `siHermes` — that is a DIFFERENT brand (fashion house).
 *  - clawboo-native → Clawboo's own ghost-lobster mascot silhouette (in-repo
 *    public/logo.svg) in the MASCOT'S red (#ff4d4d, = logo.svg + boo-avatar TINTS[0]),
 *    NOT mint — it is the Clawboo mascot, so it wears the mascot's colour.
 *  - OpenClawIcon → the real OpenClaw mark (lobe-icons `openclaw`, MIT) in
 *    OpenClaw red. OpenClaw is not a `RuntimeId`, so it's a sibling export.
 *
 * Brand hex is confined to this map — the documented design-system exception for
 * brand marks; all card chrome derives from theme tokens via color-mix.
 */
import {
  clawbooNativeMark,
  claudeCodeMark,
  codexMark,
  hermesMark,
  openclawMark,
  type BrandGlyph,
} from '@/lib/brandPaths'

import type { RuntimeId } from './runtimeCatalog'

interface RuntimeBrandMark {
  color: string
  glyph: BrandGlyph
}

export const RUNTIME_BRAND: Record<RuntimeId, RuntimeBrandMark> = {
  'clawboo-native': { color: '#ff4d4d', glyph: clawbooNativeMark },
  'claude-code': { color: '#D97757', glyph: claudeCodeMark },
  // Codex (OpenAI) + Hermes are monochrome brands — render in the theme
  // foreground (black on light, white on dark), not a made-up accent.
  codex: { color: 'currentColor', glyph: codexMark },
  hermes: { color: 'currentColor', glyph: hermesMark },
}

/** A brand glyph (fill paths + optional stroke paths) rendered in `currentColor`. */
export function MarkGlyph({ glyph, size }: { glyph: BrandGlyph; size: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox={glyph.viewBox ?? '0 0 24 24'}
      fill="currentColor"
      fillRule="evenodd"
      clipRule="evenodd"
      role="img"
      aria-hidden
    >
      {glyph.paths.map((d, i) => (
        <path key={i} d={d} />
      ))}
      {glyph.strokePaths?.map((d, i) => (
        <path
          key={`s${i}`}
          d={d}
          fill="none"
          stroke="currentColor"
          strokeWidth={glyph.strokeWidth ?? 2.5}
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      ))}
    </svg>
  )
}

/** The shared tinted-tile renderer for a mono brand glyph. */
function BrandTile({ color, glyph, size }: { color: string; glyph: BrandGlyph; size: number }) {
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
        color,
        background: 'color-mix(in srgb, currentColor 14%, transparent)',
        flexShrink: 0,
      }}
    >
      <MarkGlyph glyph={glyph} size={Math.round(size * 0.6)} />
    </span>
  )
}

export interface RuntimeIconProps {
  id: RuntimeId
  /** Tile edge length in px. Glyph scales to ~60% of this. */
  size?: number
}

export function RuntimeIcon({ id, size = 36 }: RuntimeIconProps) {
  const brand = RUNTIME_BRAND[id]
  return <BrandTile color={brand.color} glyph={brand.glyph} size={size} />
}

/** The real OpenClaw mark in OpenClaw red — for surfaces that show OpenClaw
 *  beside the RuntimeId tiles (runtime tabs, the team runtime picker). */
export function OpenClawIcon({ size = 36 }: { size?: number }) {
  return <BrandTile color="#E94560" glyph={openclawMark} size={size} />
}

/** Display name for any agent runtime value (incl. OpenClaw + the null default). */
export function runtimeLabel(runtime?: string | null): string {
  switch (runtime) {
    case 'clawboo-native':
      return 'Clawboo Native'
    case 'claude-code':
      return 'Claude Code'
    case 'codex':
      return 'Codex'
    case 'hermes':
      return 'Hermes'
    default:
      return 'OpenClaw' // 'openclaw' or null / unknown → the default runtime
  }
}

const RUNTIME_ICON_IDS: readonly string[] = ['clawboo-native', 'claude-code', 'codex', 'hermes']

/** The runtime mark for an AGENT's `runtime` value — resolves the RuntimeId tile or the
 *  OpenClaw sibling (OpenClaw is not a RuntimeId; null / unknown falls back to it), with
 *  the runtime name as a tooltip. Shown beside the agent-detail model selector so an
 *  agent's runtime is visible at a glance. */
export function AgentRuntimeBadge({
  runtime,
  size = 28,
}: {
  runtime?: string | null
  size?: number
}) {
  const label = runtimeLabel(runtime)
  return (
    <span
      title={`Runtime: ${label}`}
      aria-label={`Runtime: ${label}`}
      style={{ display: 'inline-flex', flexShrink: 0 }}
    >
      {RUNTIME_ICON_IDS.includes(runtime ?? '') ? (
        <RuntimeIcon id={runtime as RuntimeId} size={size} />
      ) : (
        <OpenClawIcon size={size} />
      )}
    </span>
  )
}

/** Resolve the brand mark (color + glyph) + display name for any agent runtime value,
 *  handling OpenClaw (not a RuntimeId) + the null default. Used to build the fused
 *  runtime-icon + model control. */
export function resolveRuntimeMark(runtime?: string | null): {
  color: string
  glyph: BrandGlyph
  label: string
} {
  const label = runtimeLabel(runtime)
  if (runtime && RUNTIME_ICON_IDS.includes(runtime)) {
    const b = RUNTIME_BRAND[runtime as RuntimeId]
    return { color: b.color, glyph: b.glyph, label }
  }
  return { color: '#E94560', glyph: openclawMark, label }
}
