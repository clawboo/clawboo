// The shared dashboard-panel header. Every nav view gets the same clean header
// rhythm: an optional icon, a bold Inter title, an optional subtitle, and a
// right-aligned actions slot (refresh, star, filters, primary CTA…).

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'

export interface PanelHeaderProps {
  title: ReactNode
  subtitle?: ReactNode
  icon?: LucideIcon
  actions?: ReactNode
  /** `lg` = page-level title; `md` = compact panel title. */
  size?: 'md' | 'lg'
  /** Add a hairline bottom border under the header. */
  border?: boolean
  className?: string
}

export function PanelHeader({
  title,
  subtitle,
  icon: Icon,
  actions,
  size = 'lg',
  border = false,
  className = '',
}: PanelHeaderProps) {
  return (
    <div
      className={[
        'flex items-center justify-between gap-4 px-6',
        size === 'lg' ? 'min-h-[68px] py-4' : 'min-h-[52px] py-3',
        border ? 'border-b border-border' : '',
        className,
      ].join(' ')}
    >
      <div className="flex min-w-0 items-center gap-3">
        {Icon ? (
          <span
            className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl"
            style={{ background: 'rgb(var(--foreground-rgb) / 0.05)', color: 'var(--foreground)' }}
          >
            <Icon size={18} strokeWidth={2} />
          </span>
        ) : null}
        <div className="min-w-0">
          <h1
            className="truncate font-display font-bold text-foreground"
            style={{
              fontSize: size === 'lg' ? 22 : 17,
              letterSpacing: '-0.02em',
              lineHeight: 1.15,
            }}
          >
            {title}
          </h1>
          {subtitle ? (
            <p className="mt-0.5 truncate text-[13px] text-foreground/50">{subtitle}</p>
          ) : null}
        </div>
      </div>
      {actions ? <div className="flex shrink-0 items-center gap-2">{actions}</div> : null}
    </div>
  )
}
