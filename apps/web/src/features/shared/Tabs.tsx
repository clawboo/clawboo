// Underline tab bar (the reference "Explore / My Voices" pattern). Active tab
// gets a foreground label + a brand-red underline; the rest are muted.

import type { LucideIcon } from 'lucide-react'

export interface TabItem<T extends string = string> {
  id: T
  label: string
  icon?: LucideIcon
  count?: number
}

export interface TabsProps<T extends string = string> {
  tabs: TabItem<T>[]
  value: T
  onChange: (id: T) => void
  className?: string
}

export function Tabs<T extends string = string>({
  tabs,
  value,
  onChange,
  className = '',
}: TabsProps<T>) {
  return (
    // No full-width baseline — the active tab's own red underline is the anchor.
    // A gray baseline here would stack directly against the search field below it
    // (two hairlines a few px apart), which reads as heavy / unrefined.
    <div role="tablist" className={['flex items-center gap-1', className].join(' ')}>
      {tabs.map((t) => {
        const active = t.id === value
        const Icon = t.icon
        return (
          <button
            key={t.id}
            role="tab"
            type="button"
            aria-selected={active}
            onClick={() => onChange(t.id)}
            className={[
              // Balanced vertical padding — the label sits centered in the tab,
              // not hugging the top edge.
              'relative inline-flex items-center gap-1.5 px-3 py-2 text-[14px] font-medium',
              'transition-colors duration-150 cursor-pointer',
              active ? 'text-foreground' : 'text-foreground/50 hover:text-foreground/80',
            ].join(' ')}
          >
            {Icon ? <Icon size={15} strokeWidth={2} /> : null}
            {t.label}
            {typeof t.count === 'number' ? (
              <span className="font-data text-[12px] text-foreground/40 tabular-nums">
                {t.count}
              </span>
            ) : null}
            <span
              aria-hidden
              className="absolute inset-x-2 bottom-0 h-0.5 rounded-full transition-opacity duration-150"
              style={{ background: 'var(--primary)', opacity: active ? 1 : 0 }}
            />
          </button>
        )
      })}
    </div>
  )
}
