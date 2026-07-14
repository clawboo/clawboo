import { MarkGlyph, resolveRuntimeMark } from '@/features/runtimes/RuntimeBrand'

// ─── RuntimeBadge — a runtime brand chip on a Boo's avatar ────────────────────
//
// A small brand chip overlaid on the bottom-right corner of a Boo's avatar in
// the Ghost Graph — the way a platform badge sits on an app icon — so an agent's
// runtime (Clawboo Native / OpenClaw / Claude Code / Codex / Hermes) is legible
// at a glance across the whole graph.
//
// Placement contract (see BooNode.tsx): rendered as a `position: absolute` child
// of the avatar wrapper so it (a) rides the avatar's FLIP morph for free without
// altering the FLIP-measured rect, and (b) is never clipped (the morph wrapper is
// `overflow: visible`). `pointerEvents: 'none'` so this decorative chip never
// intercepts the Boo's click / drag / hover.
//
// Colour: `resolveRuntimeMark` returns a fixed brand hex for clawboo-native /
// claude-code / openclaw and the literal `'currentColor'` for the mono brands
// (codex / hermes) — pinned here to the theme foreground so the chip is
// deterministic over the canvas rather than inheriting an ambient colour.

export function RuntimeBadge({ runtime, size = 20 }: { runtime?: string | null; size?: number }) {
  const mark = resolveRuntimeMark(runtime)
  const ink = mark.color === 'currentColor' ? 'var(--foreground)' : mark.color
  const offset = -Math.round(size * 0.14)
  return (
    <span
      // `role="img"` + `aria-label` is the reliable accessible-name pattern (a
      // bare span exposes no name); `title` is a best-effort fallback (it can't
      // fire on hover because the chip is `pointerEvents:none`, which is
      // load-bearing so it never steals the Boo's hover cascade).
      role="img"
      title={`Runtime: ${mark.label}`}
      aria-label={`Runtime: ${mark.label}`}
      style={{
        position: 'absolute',
        right: offset,
        bottom: offset,
        width: size,
        height: size,
        borderRadius: Math.round(size * 0.32),
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        color: ink,
        // A NEUTRAL surface chip (not a same-hue brand wash) so the glyph stays
        // legible in both themes, plus a bold brand-coloured RING as the primary
        // at-a-glance colour cue — a larger, higher-contrast signal than the tiny
        // glyph, which is inherently low-contrast for saturated brand hues on a
        // light chip. The outer surface halo separates the chip from the mascot.
        background: 'var(--surface)',
        border: `1.5px solid ${ink}`,
        boxShadow: '0 0 0 2px var(--surface)',
        pointerEvents: 'none',
        zIndex: 4,
      }}
    >
      <MarkGlyph glyph={mark.glyph} size={Math.round(size * 0.62)} />
    </span>
  )
}
