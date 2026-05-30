/**
 * Normalize a stored team accent color to a safe 6-digit hex.
 *
 * Early builds stored CSS variables (`var(--primary)` / `var(--mint)` /
 * `var(--amber)`) as `team.color`. Those break the hex-alpha concatenation
 * (`${color}22`) used across the app — an invalid color that renders as opaque
 * BLACK in SVG (e.g. team halos) and transparent in HTML. New teams only ever
 * get hex now (see `TEAM_ACCENT_PRESETS`); this maps any legacy var value back
 * to the equivalent hex on read, so existing teams render correctly everywhere.
 *
 * Hex values match the first three `TEAM_ACCENT_PRESETS` entries.
 */
const LEGACY_VAR_HEX: Record<string, string> = {
  'var(--primary)': '#e94560',
  'var(--mint)': '#34d399',
  'var(--amber)': '#fbbf24',
}

export function normalizeTeamColor(color: string | null | undefined): string {
  if (!color) return '#e94560' // primary fallback for missing colors
  const trimmed = color.trim()
  return LEGACY_VAR_HEX[trimmed] ?? trimmed
}
