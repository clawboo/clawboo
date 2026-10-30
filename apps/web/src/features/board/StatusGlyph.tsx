// The board's status marks: a status is a small drawn shape, and its words live
// in headers, pickers and tooltips. One ring family on a 14px grid with 1.5px
// strokes, so the marks sit beside Lucide's icons. Each column's colour lives
// here and nowhere else on the board: lanes, headers and cards stay neutral.

export type StatusGlyphKind =
  'needs_you' | 'backlog' | 'todo' | 'in_progress' | 'verifying' | 'done' | 'cancelled'

const COLOR: Record<StatusGlyphKind, string> = {
  needs_you: 'var(--amber)',
  backlog: 'var(--category-other)',
  todo: 'var(--category-data)',
  in_progress: 'var(--category-web)',
  verifying: 'var(--mint)',
  done: 'var(--mint)',
  cancelled: 'var(--category-other)',
}

/** The glyph for a board column, or for an off-list status (a plain ring). */
export function glyphKindOf(columnId: string): StatusGlyphKind {
  return columnId in COLOR ? (columnId as StatusGlyphKind) : 'todo'
}

const RING = { cx: 7, cy: 7, r: 5.75, stroke: 'currentColor', strokeWidth: 1.5 } as const

function shape(kind: StatusGlyphKind) {
  switch (kind) {
    case 'backlog':
      // Eight dashes: work parked, not yet in line.
      return <circle {...RING} pathLength={16} strokeDasharray="1.15 0.85" />
    case 'todo':
      return <circle {...RING} />
    case 'in_progress':
      return (
        <>
          <circle {...RING} />
          <path d="M7 3.5a3.5 3.5 0 0 1 0 7z" fill="currentColor" />
        </>
      )
    case 'verifying':
      return (
        <>
          <circle {...RING} />
          <circle cx={7} cy={7} r={2.25} fill="currentColor" />
        </>
      )
    case 'done':
      return (
        <>
          <circle cx={7} cy={7} r={6.5} fill="currentColor" />
          <path
            d="M4.4 7.3l1.75 1.75L9.7 5.4"
            stroke="var(--surface)"
            strokeWidth={1.5}
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </>
      )
    case 'cancelled':
      return (
        <>
          <circle {...RING} />
          <path
            d="M5.1 5.1l3.8 3.8M8.9 5.1L5.1 8.9"
            stroke="currentColor"
            strokeWidth={1.5}
            strokeLinecap="round"
          />
        </>
      )
    case 'needs_you':
      return (
        <>
          <circle cx={7} cy={7} r={6.5} fill="currentColor" />
          <path d="M7 3.9v3.8" stroke="var(--surface)" strokeWidth={1.6} strokeLinecap="round" />
          <circle cx={7} cy={10.1} r={0.95} fill="var(--surface)" />
        </>
      )
  }
}

export function StatusGlyph({
  kind,
  size = 12,
  muted = false,
  className,
}: {
  kind: StatusGlyphKind
  size?: number
  /** Drawn in the muted ink instead of its colour: nothing is waiting. */
  muted?: boolean
  className?: string
}) {
  return (
    <svg
      aria-hidden
      data-glyph={kind}
      width={size}
      height={size}
      viewBox="0 0 14 14"
      fill="none"
      className={`shrink-0${className ? ` ${className}` : ''}`}
      style={{ color: muted ? 'var(--muted-foreground)' : COLOR[kind] }}
    >
      {shape(kind)}
    </svg>
  )
}
