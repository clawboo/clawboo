// Reusable jargon tooltip primitive.
//
// Wraps a term the first-run user may not know ("Gateway", "runtime", "Native")
// with a dotted underline + a small on-hover / on-focus definition popover.
// Keyboard-accessible (the trigger is a focusable <button>, the definition is
// announced via aria-describedby), and reduced-motion-safe (the global
// prefers-reduced-motion guard neutralizes the fade).
//
// API: <GlossTerm term="Gateway" definition="…">Gateway</GlossTerm> — the child
// is the visible text (defaults to `term`); `definition` is the popover copy.

import { useId, useState, type CSSProperties, type ReactNode } from 'react'

export interface GlossTermProps {
  /** The jargon term (used as the accessible name + the default visible text). */
  term: string
  /** The plain-language explanation shown in the popover. */
  definition: string
  /** Visible text; defaults to `term`. */
  children?: ReactNode
  className?: string
  style?: CSSProperties
}

export function GlossTerm({ term, definition, children, className, style }: GlossTermProps) {
  const id = useId()
  const [open, setOpen] = useState(false)

  return (
    <span className="relative inline-block" style={style}>
      <button
        type="button"
        aria-describedby={id}
        onMouseEnter={() => setOpen(true)}
        onMouseLeave={() => setOpen(false)}
        onFocus={() => setOpen(true)}
        onBlur={() => setOpen(false)}
        onKeyDown={(e) => {
          if (e.key === 'Escape') setOpen(false)
        }}
        className={`cursor-help border-0 bg-transparent p-0 font-[inherit] text-[inherit] ${
          className ?? ''
        }`}
        style={{
          borderBottom: '1px dotted rgb(var(--foreground-rgb) / 0.45)',
          lineHeight: 'inherit',
        }}
      >
        {children ?? term}
      </button>
      <span
        role="tooltip"
        id={id}
        className="surface-floating-tier font-body"
        style={{
          position: 'absolute',
          top: '100%',
          left: '50%',
          transform: 'translateX(-50%)',
          marginTop: 6,
          width: 'max-content',
          maxWidth: 240,
          padding: '8px 10px',
          borderRadius: 10,
          fontSize: 11.5,
          lineHeight: 1.5,
          color: 'var(--foreground)',
          textAlign: 'left',
          whiteSpace: 'normal',
          zIndex: 60,
          opacity: open ? 1 : 0,
          visibility: open ? 'visible' : 'hidden',
          pointerEvents: 'none',
          transition: 'opacity 150ms var(--motion-easing-standard)',
        }}
      >
        {definition}
      </span>
    </span>
  )
}
