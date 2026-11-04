// The canonical uppercase mono "kicker" / section-label recipe. Shared across
// dashboard panels so every section header uses the exact same treatment
// (Geist Mono, 11px, uppercase, wide tracking, muted). Append layout utilities
// as needed, e.g. `${SECTION_LABEL} mb-2 flex items-center gap-1.5`.
//
// The size is the scale's `text-micro` and the colour the muted text token: a
// faded foreground (it was /45) falls under the muted-text contrast floor.
export const SECTION_LABEL =
  'font-mono text-micro font-semibold uppercase tracking-[0.14em] text-muted-foreground'
