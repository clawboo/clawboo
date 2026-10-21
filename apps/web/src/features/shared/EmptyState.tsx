// Reusable branded empty-state primitive.
//
// Canonical pattern: 56-px circular icon disc + Lucide icon @ 26 px /
// strokeWidth 1.75 + a display-font title + a smaller helper line + an
// optional CTA. A surface with its own illustration (a Boo, say) passes
// `art`, which takes the disc's place.
//
// Every empty state in the app uses it, so they all read with the same rhythm.

import type { LucideIcon } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'

export type EmptyStateTone = 'neutral' | 'mint' | 'amber' | 'primary'

export interface EmptyStateProps {
  /** The icon drawn in the disc. Ignored when `art` is given. */
  icon?: LucideIcon
  /** An illustration drawn in place of the icon disc, at its own size. */
  art?: ReactNode
  title: string
  helper?: ReactNode
  /** Optional CTA rendered below the helper. */
  action?: ReactNode
  /** Color treatment for the icon disc. Defaults to `neutral` (foreground). */
  tone?: EmptyStateTone
  /** Top padding override for tight contexts. Defaults to 48 px. */
  paddingTop?: number
  className?: string
  style?: CSSProperties
}

const TONE_PALETTE: Record<
  EmptyStateTone,
  { discBg: string; discBorder: string; iconColor: string }
> = {
  neutral: {
    discBg: 'rgb(var(--foreground-rgb) / 0.05)',
    discBorder: 'rgb(var(--foreground-rgb) / 0.1)',
    iconColor: 'rgb(var(--foreground-rgb) / 0.55)',
  },
  mint: {
    discBg: 'rgb(var(--mint-rgb) / 0.1)',
    discBorder: 'rgb(var(--mint-rgb) / 0.2)',
    iconColor: 'var(--mint)',
  },
  amber: {
    discBg: 'rgb(var(--amber-rgb) / 0.1)',
    discBorder: 'rgb(var(--amber-rgb) / 0.2)',
    iconColor: 'var(--amber)',
  },
  primary: {
    discBg: 'rgb(var(--primary-rgb) / 0.1)',
    discBorder: 'rgb(var(--primary-rgb) / 0.2)',
    iconColor: 'var(--primary)',
  },
}

export function EmptyState({
  icon: Icon,
  art,
  title,
  helper,
  action,
  tone = 'neutral',
  paddingTop = 48,
  className,
  style,
}: EmptyStateProps) {
  const palette = TONE_PALETTE[tone]

  return (
    <div
      className={className}
      style={{
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 10,
        paddingTop,
        paddingLeft: 24,
        paddingRight: 24,
        textAlign: 'center',
        ...style,
      }}
    >
      {art ? (
        <div aria-hidden style={{ display: 'flex', justifyContent: 'center' }}>
          {art}
        </div>
      ) : Icon ? (
        <div
          aria-hidden
          style={{
            display: 'flex',
            width: 56,
            height: 56,
            alignItems: 'center',
            justifyContent: 'center',
            borderRadius: 999,
            background: palette.discBg,
            border: `1px solid ${palette.discBorder}`,
          }}
        >
          <Icon size={26} strokeWidth={1.75} color={palette.iconColor} />
        </div>
      ) : null}
      <span
        style={{
          fontSize: 16,
          fontWeight: 600,
          color: 'rgb(var(--foreground-rgb) / 0.7)',
          fontFamily: 'var(--font-display)',
          letterSpacing: '-0.01em',
        }}
      >
        {title}
      </span>
      {helper !== undefined && helper !== null && (
        <div
          style={{
            marginTop: 2,
            fontSize: 12,
            color: 'var(--muted-foreground)',
            lineHeight: 1.6,
            maxWidth: 280,
          }}
        >
          {helper}
        </div>
      )}
      {action && <div style={{ marginTop: 12 }}>{action}</div>}
    </div>
  )
}
