// Reusable inline alert/banner primitive (Phase 20a).
//
// A premium-SaaS callout that leads with a semantic Lucide icon
// (info / warning / error) instead of a bare `!` punctuation character.
// General-purpose — drop it in for any in-flow callout.
//
// Renders as a thin horizontal strip with a leading icon + body, suitable
// for in-flow callouts (NOT toast notifications — those have their own
// motion system in stores/toast.ts).

import { AlertCircle, Info, XCircle } from 'lucide-react'
import type { CSSProperties, ReactNode } from 'react'

export type AlertTone = 'info' | 'warning' | 'error'

export interface FormattedAlertProps {
  tone: AlertTone
  /** Body content — string or rich ReactNode. */
  children: ReactNode
  /** Optional override icon. Defaults to tone-appropriate Lucide icon. */
  icon?: typeof Info
  className?: string
  style?: CSSProperties
}

const TONE_PALETTE: Record<
  AlertTone,
  { bg: string; border: string; icon: typeof Info; iconColor: string }
> = {
  info: {
    bg: 'rgb(var(--foreground-rgb) / 0.05)',
    border: 'rgb(var(--foreground-rgb) / 0.1)',
    icon: Info,
    iconColor: 'rgb(var(--foreground-rgb) / 0.6)',
  },
  warning: {
    bg: 'rgb(var(--amber-rgb) / 0.1)',
    border: 'rgb(var(--amber-rgb) / 0.25)',
    icon: AlertCircle,
    iconColor: 'var(--amber)',
  },
  error: {
    bg: 'rgb(var(--primary-rgb) / 0.1)',
    border: 'rgb(var(--primary-rgb) / 0.25)',
    icon: XCircle,
    iconColor: 'var(--primary)',
  },
}

export function FormattedAlert({ tone, children, icon, className, style }: FormattedAlertProps) {
  const palette = TONE_PALETTE[tone]
  const Icon = icon ?? palette.icon

  return (
    <div
      role={tone === 'error' ? 'alert' : 'status'}
      className={className}
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 10,
        padding: '10px 12px',
        borderRadius: 8,
        background: palette.bg,
        border: `1px solid ${palette.border}`,
        fontSize: 12,
        lineHeight: 1.5,
        color: 'rgb(var(--foreground-rgb) / 0.75)',
        ...style,
      }}
    >
      <Icon
        size={14}
        strokeWidth={2}
        color={palette.iconColor}
        style={{ flexShrink: 0, marginTop: 1 }}
      />
      <div style={{ flex: 1, minWidth: 0 }}>{children}</div>
    </div>
  )
}
