// Filter chip / pill — a rounded outline pill with an optional leading icon and
// active state (the reference filter-bar pattern). Use for filter bars and tags.

import type { ReactNode } from 'react'
import type { LucideIcon } from 'lucide-react'
import { ChevronDown } from 'lucide-react'

export interface ChipProps {
  children: ReactNode
  active?: boolean
  onClick?: () => void
  icon?: LucideIcon
  /** Render a trailing chevron (for dropdown-style filter chips). */
  dropdown?: boolean
  /** Optional accent color for the active state (defaults to brand red). */
  accent?: string
  size?: 'sm' | 'md'
  className?: string
}

export function Chip({
  children,
  active = false,
  onClick,
  icon: Icon,
  dropdown = false,
  accent,
  size = 'md',
  className = '',
}: ChipProps) {
  const dims = size === 'sm' ? 'h-7 px-2.5 text-[12.5px]' : 'h-8 px-3.5 text-[13px]'
  const activeColor = accent ?? 'var(--primary)'
  return (
    <button
      type="button"
      onClick={onClick}
      aria-pressed={active}
      className={[
        'inline-flex items-center gap-1.5 rounded-full border font-medium transition-all duration-150',
        'cursor-pointer whitespace-nowrap',
        dims,
        active ? '' : 'border-border text-foreground/65 hover:border-border-strong hover:text-foreground',
        className,
      ].join(' ')}
      style={
        active
          ? {
              borderColor: activeColor,
              color: activeColor,
              background: `color-mix(in srgb, ${activeColor} 8%, transparent)`,
            }
          : undefined
      }
    >
      {Icon ? <Icon size={14} strokeWidth={2} /> : null}
      {children}
      {dropdown ? <ChevronDown size={14} className="opacity-60" /> : null}
    </button>
  )
}
