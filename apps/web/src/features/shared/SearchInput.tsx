// Search field — a rounded input with a leading search icon, an optional
// clear button, and the brand-red focus ring. One consistent search across the app.

import { Search, X } from 'lucide-react'

export interface SearchInputProps {
  value: string
  onChange: (v: string) => void
  placeholder?: string
  size?: 'sm' | 'md' | 'lg'
  autoFocus?: boolean
  onKeyDown?: (e: React.KeyboardEvent<HTMLInputElement>) => void
  className?: string
  'aria-label'?: string
}

const DIMS = {
  sm: { wrap: 'h-8 rounded-lg pl-8 pr-8 text-[13px]', icon: 14, ipos: 'left-2.5' },
  md: { wrap: 'h-9 rounded-lg pl-9 pr-9 text-[13.5px]', icon: 15, ipos: 'left-3' },
  lg: { wrap: 'h-11 rounded-xl pl-11 pr-11 text-[15px]', icon: 18, ipos: 'left-3.5' },
} as const

export function SearchInput({
  value,
  onChange,
  placeholder = 'Search…',
  size = 'md',
  autoFocus,
  onKeyDown,
  className = '',
  'aria-label': ariaLabel,
}: SearchInputProps) {
  const d = DIMS[size]
  return (
    <div className={['relative w-full', className].join(' ')}>
      <Search
        size={d.icon}
        strokeWidth={2}
        className={['pointer-events-none absolute top-1/2 -translate-y-1/2 text-foreground/35', d.ipos].join(
          ' ',
        )}
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        aria-label={ariaLabel ?? placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        className={[
          'w-full border border-border bg-surface text-foreground outline-none transition',
          'placeholder:text-foreground/35 focus:border-primary focus:ring-4 focus:ring-primary/15',
          d.wrap,
        ].join(' ')}
      />
      {value ? (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => onChange('')}
          className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md p-1 text-foreground/40 transition-colors hover:text-foreground/70 cursor-pointer"
        >
          <X size={d.icon - 1} />
        </button>
      ) : null}
    </div>
  )
}
