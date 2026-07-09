// Segmented control — a pill track with the active segment as a raised chip.
// Used for small mutually-exclusive choices (Monthly/Yearly, runtime pick, etc.).

import type { LucideIcon } from 'lucide-react'

export interface SegmentOption<T extends string = string> {
  id: T
  label: string
  icon?: LucideIcon
}

export interface SegmentedControlProps<T extends string = string> {
  options: SegmentOption<T>[]
  value: T
  onChange: (id: T) => void
  size?: 'sm' | 'md'
  className?: string
  'aria-label'?: string
}

export function SegmentedControl<T extends string = string>({
  options,
  value,
  onChange,
  size = 'md',
  className = '',
  'aria-label': ariaLabel,
}: SegmentedControlProps<T>) {
  const pad = size === 'sm' ? 'h-8 text-[12.5px]' : 'h-9 text-[13.5px]'
  return (
    <div
      role="radiogroup"
      aria-label={ariaLabel}
      className={[
        'inline-flex items-center gap-1 rounded-xl border border-border bg-foreground/[0.03] p-1',
        className,
      ].join(' ')}
    >
      {options.map((o) => {
        const active = o.id === value
        const Icon = o.icon
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.id)}
            className={[
              'inline-flex items-center gap-1.5 rounded-lg px-3 font-medium transition-all duration-150 cursor-pointer',
              pad,
              active
                ? 'bg-surface text-foreground shadow-[var(--shadow-raised)]'
                : 'text-foreground/55 hover:text-foreground/80',
            ].join(' ')}
          >
            {Icon ? <Icon size={14} strokeWidth={2} /> : null}
            {o.label}
          </button>
        )
      })}
    </div>
  )
}
