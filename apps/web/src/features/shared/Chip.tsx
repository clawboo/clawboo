// Filter chip / pill — a rounded outline pill with an optional leading icon and
// active state (the reference filter-bar pattern). Use for filter bars and tags.
//
// INTERACTIVE OR NOT, decided by whether an `onClick` was given. A chip with no
// handler is a LABEL, and rendering it as a <button> is wrong twice over: it is
// invalid HTML inside another button (which is exactly how connector cards use
// it), and it puts an unreachable, unlabelled stop in the tab order that
// announces itself as pressable and then does nothing.

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
  const interactive = typeof onClick === 'function'
  const Tag = interactive ? 'button' : 'span'
  return (
    <Tag
      {...(interactive
        ? // `aria-pressed` only on something that can actually be pressed:
          // announcing a toggle state on static text is a lie to a screen reader.
          ({ type: 'button', onClick, 'aria-pressed': active } as const)
        : {})}
      className={[
        'inline-flex items-center gap-1.5 rounded-full border font-medium transition-all duration-150',
        interactive ? 'cursor-pointer' : '',
        'whitespace-nowrap',
        dims,
        active
          ? ''
          : 'border-border text-foreground/65 hover:border-border-strong hover:text-foreground',
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
    </Tag>
  )
}
