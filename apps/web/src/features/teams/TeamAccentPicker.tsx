/**
 * Manual team-accent color picker — the original 8-swatch circle picker.
 *
 * This sets the team's `color` (icon background, halo, header accent, deploy
 * button) and is intentionally SEPARATE from the Boo color *collection*
 * (`TeamColorCollectionPicker`), which only drives the per-Boo avatar palette.
 */

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

export function TeamAccentPicker({ value, onChange }: TeamAccentPickerProps) {
  return (
    <div className="flex flex-wrap gap-2">
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
    </div>
  )
}
