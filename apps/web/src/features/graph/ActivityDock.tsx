import { Terminal, X } from 'lucide-react'
import { useReducedMotion } from 'framer-motion'

import { ActivityTerminal } from '@/features/obs/ActivityTerminal'
import type { ObsScope } from '@/features/obs/useObsStream'
import { useDismissableLayer } from '@/features/shared/useDismissableLayer'

// ─── ActivityDock ────────────────────────────────────────────────────────────
//
// The live "what is it doing" terminal, docked to a graph's right edge. Every
// graph canvas mounts one, scoped to what that canvas draws: Atlas to every
// team, a group chat's graph to its team, the 1:1 mini graph to its one agent.
// One component so the three read as the same control rather than three
// lookalikes that drift.
//
// Always mounted so the slide animates both ways; the obs subscription is gated
// on `open`, so a closed dock tails nothing.

/** The panel's widest, before the graph pane's own width caps it. */
const DOCK_WIDTH = 380

export function ActivityDock({
  open,
  onClose,
  scope,
  scopeLabel,
}: {
  open: boolean
  onClose: () => void
  scope: ObsScope
  /** Beside the title, naming the scope: "all teams", a team, an agent. */
  scopeLabel: string
}) {
  const reduceMotion = useReducedMotion()
  // Escape closes it, the way it closes the browser dock that shares this edge.
  // A popover-level layer, so a dropdown or dialog above it still takes Escape
  // first.
  useDismissableLayer({ active: open, level: 'popover', onEscape: onClose })

  return (
    <div
      role="complementary"
      aria-label={`Activity, ${scopeLabel}`}
      aria-hidden={!open}
      className="surface-floating-tier"
      style={{
        position: 'absolute',
        top: 0,
        right: 0,
        bottom: 0,
        width: `min(${DOCK_WIDTH}px, 82%)`,
        zIndex: 25,
        display: 'flex',
        flexDirection: 'column',
        borderTopLeftRadius: 14,
        borderBottomLeftRadius: 14,
        transform: open ? 'translateX(0)' : 'translateX(calc(100% + 24px))',
        transition: reduceMotion ? 'none' : 'transform 0.32s cubic-bezier(0.32, 0.72, 0, 1)',
        pointerEvents: open ? 'auto' : 'none',
      }}
    >
      <div
        style={{
          height: 44,
          flexShrink: 0,
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          padding: '0 14px',
          borderBottom: '1px solid rgb(var(--foreground-rgb) / 0.08)',
        }}
      >
        <Terminal size={14} style={{ color: 'var(--mint)', flexShrink: 0 }} />
        <span
          style={{
            fontSize: 13,
            fontWeight: 600,
            fontFamily: 'var(--font-display)',
            letterSpacing: '-0.01em',
            color: 'var(--foreground)',
          }}
        >
          Activity
        </span>
        <span
          className="truncate"
          style={{
            minWidth: 0,
            fontSize: 11,
            color: 'var(--muted-foreground)',
            fontFamily: 'var(--font-mono)',
          }}
        >
          {scopeLabel}
        </span>
        <span style={{ flex: 1 }} />
        <button
          type="button"
          aria-label="Close activity"
          tabIndex={open ? undefined : -1}
          onClick={onClose}
          className="flex shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors duration-150 hover:bg-foreground/[0.06] hover:text-foreground"
          style={{
            width: 28,
            height: 28,
            border: 'none',
            background: 'transparent',
            cursor: 'pointer',
          }}
        >
          <X size={16} />
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0, padding: 12 }}>
        <ActivityTerminal scope={scope} fill hideHeader enabled={open} />
      </div>
    </div>
  )
}
