/**
 * Manual team-accent color picker — 8 preset swatches + a custom color picker.
 *
 * This sets the team's `color` (icon background, halo, header accent, deploy
 * button) and is intentionally SEPARATE from the Boo color *collection*
 * (`TeamColorCollectionPicker`), which only drives the per-Boo avatar palette.
 */

import { Pipette } from 'lucide-react'

// IMPORTANT: these MUST stay 6-digit hex — never CSS vars like `var(--primary)`.
// `team.color` is string-concatenated with a hex-alpha suffix (`${color}22`)
// in ~40 places across the app (icon tints, halos, chips, cards). A `var(...)`
// string breaks that concatenation (`var(--primary)22` is invalid → renders as
// opaque BLACK in SVG / transparent in HTML). Keeping the source hex makes
// every one of those sites safe by construction. The first three are the
// brand red / mint / amber resolved to their canonical hex.
export const TEAM_ACCENT_PRESETS = [
  '#e94560', // primary (OpenClaw red)
  '#34d399', // mint
  '#fbbf24', // amber
  '#60A5FA',
  '#A78BFA',
  '#F472B6',
  '#38BDF8',
  '#FB923C',
] as const

interface TeamAccentPickerProps {
  value: string
  onChange: (color: string) => void
}

/** True when a hex color is perceptually light (so a dark icon reads on it). */
function isLightHex(hex: string): boolean {
  const m = hex.trim().match(/^#?([0-9a-fA-F]{6})$/)
  if (!m) return false
  const n = parseInt(m[1], 16)
  // sRGB-weighted perceived luminance, 0–255.
  const lum = 0.299 * ((n >> 16) & 255) + 0.587 * ((n >> 8) & 255) + 0.114 * (n & 255)
  return lum > 150
}

export function TeamAccentPicker({ value, onChange }: TeamAccentPickerProps) {
  // When the current color isn't one of the presets, the custom slot is the
  // active selection (e.g. a color picked via the eyedropper) — and the swatch
  // is FILLED with that color.
  const customActive = !(TEAM_ACCENT_PRESETS as readonly string[]).includes(value)
  // The native <input type="color"> needs a valid #rrggbb; guard defensively.
  const inputValue = /^#[0-9a-fA-F]{6}$/.test(value) ? value : TEAM_ACCENT_PRESETS[0]

  // Keep the eyedropper readable on ANY background: white over the rainbow /
  // dark fills, dark over a light fill — each with an opposite-color halo.
  const darkIcon = customActive && isLightHex(value)
  const iconColor = darkIcon ? '#1f2937' : '#ffffff'
  const haloRgb = darkIcon ? '255 255 255' : '0 0 0'
  const iconFilter =
    `drop-shadow(0 0 1px rgb(${haloRgb} / 0.95)) ` +
    `drop-shadow(0 0 1px rgb(${haloRgb} / 0.85)) ` +
    `drop-shadow(0 1px 1px rgb(${haloRgb} / 0.6))`

  return (
    <div className="flex flex-wrap items-center gap-2">
      {TEAM_ACCENT_PRESETS.map((color) => (
        <button
          key={color}
          type="button"
          aria-label={`Accent color ${color}`}
          onClick={() => onChange(color)}
          className="h-7 w-7 rounded-full transition-all"
          style={{
            backgroundColor: color,
            boxShadow: value === color ? `0 0 0 2px var(--background), 0 0 0 4px ${color}` : 'none',
          }}
        />
      ))}

      {/* Custom color — pick ANY color via the native eyedropper / picker.
          <input type="color"> always yields a #rrggbb value, so this preserves
          the all-hex invariant the presets enforce (no var()/named colors). */}
      <label
        title="Custom color"
        className="relative inline-flex h-7 w-7 cursor-pointer items-center justify-center rounded-full transition-all"
        style={{
          // Filled with the picked color when active; otherwise the rainbow
          // "pick any color" affordance.
          background: customActive
            ? value
            : 'conic-gradient(from 0deg, #ef4444, #f59e0b, #eab308, #22c55e, #06b6d4, #3b82f6, #8b5cf6, #ec4899, #ef4444)',
          boxShadow: customActive
            ? `0 0 0 2px var(--background), 0 0 0 4px ${value}`
            : 'inset 0 0 0 1px rgb(0 0 0 / 0.12)',
        }}
      >
        <input
          type="color"
          value={inputValue}
          onChange={(e) => onChange(e.target.value)}
          aria-label="Pick a custom team color"
          className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
        />
        {/* Always visible so users know the swatch is editable; its color + halo
            adapt to the fill brightness for guaranteed contrast on any color. */}
        <Pipette
          className="pointer-events-none h-3.5 w-3.5"
          strokeWidth={2.5}
          style={{ color: iconColor, filter: iconFilter }}
        />
      </label>
    </div>
  )
}
