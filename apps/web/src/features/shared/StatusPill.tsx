// Reusable status pill primitive.
//
// Renders the canonical mono / uppercase / tracking-widest status indicator
// used across Approvals / Scheduler / Marketplace / chat cards.
//
// API: `tone` selects the semantic role (working / done / idle / warning /
// success / error); `label` is optional — when omitted, idle / working tones
// render as a dot-only indicator (matches DelegationCard's 3-state pattern
// of Working pulse / Done mint pill / Idle gray dot).

import type { CSSProperties } from 'react'

export type StatusTone = 'working' | 'done' | 'idle' | 'warning' | 'success' | 'error'

export interface StatusPillProps {
  tone: StatusTone
  /** Pill text (mono uppercase). Omit to render as a small dot indicator. */
  label?: string
  /** Override the tone's default pulse behavior. */
  pulse?: boolean
  className?: string
  style?: CSSProperties
  /** Accessibility label when rendering as a dot-only indicator. */
  'aria-label'?: string
}

// Token-driven palette. Each tone resolves to an existing CSS var so themes
// flow through automatically (mint deepens on light mode, etc.).
const TONE_STYLES: Record<StatusTone, { bg: string; text: string; pulseByDefault: boolean }> = {
  working: {
    bg: 'rgb(var(--mint-rgb) / 0.2)',
    text: 'var(--mint)',
    pulseByDefault: true,
  },
  done: {
    bg: 'rgb(var(--mint-rgb) / 0.2)',
    text: 'var(--mint)',
    pulseByDefault: false,
  },
  idle: {
    bg: 'rgb(var(--foreground-rgb) / 0.1)',
    text: 'rgb(var(--foreground-rgb) / 0.45)',
    pulseByDefault: false,
  },
  warning: {
    bg: 'rgb(var(--amber-rgb) / 0.2)',
    text: 'var(--amber)',
    pulseByDefault: false,
  },
  success: {
    bg: 'rgb(var(--mint-rgb) / 0.2)',
    text: 'var(--mint)',
    pulseByDefault: false,
  },
  error: {
    bg: 'rgb(var(--primary-rgb) / 0.18)',
    text: 'var(--primary)',
    pulseByDefault: false,
  },
}

export function StatusPill({
  tone,
  label,
  pulse,
  className,
  style,
  'aria-label': ariaLabel,
}: StatusPillProps) {
  const palette = TONE_STYLES[tone]
  const shouldPulse = pulse ?? palette.pulseByDefault
  const isDotOnly = !label

  if (isDotOnly) {
    return (
      <span
        role="status"
        aria-label={ariaLabel ?? tone}
        className={`inline-flex items-center justify-center ${className ?? ''}`}
        style={{
          width: 8,
          height: 8,
          borderRadius: '999px',
          background: palette.text,
          opacity: shouldPulse ? undefined : 0.7,
          animation: shouldPulse ? 'clawboo-status-pulse 1.6s ease-in-out infinite' : undefined,
          ...style,
        }}
      />
    )
  }

  return (
    <span
      className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 font-mono text-[11px] font-semibold uppercase tracking-wider ${
        className ?? ''
      }`}
      style={{
        background: palette.bg,
        color: palette.text,
        ...style,
      }}
    >
      {shouldPulse && (
        <span
          aria-hidden
          style={{
            display: 'inline-block',
            width: 4,
            height: 4,
            borderRadius: '999px',
            background: palette.text,
            animation: 'clawboo-status-pulse 1.6s ease-in-out infinite',
          }}
        />
      )}
      {label}
    </span>
  )
}
