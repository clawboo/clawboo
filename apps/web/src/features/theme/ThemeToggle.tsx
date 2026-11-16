import { Monitor, Moon, Sun } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'

import { useTheme } from './useTheme'
import type { ThemePreference } from './ThemeProvider'

// A macOS-style 3-way segmented theme switch: System / Light / Dark. The active
// segment (the current PREFERENCE, not the resolved mode) is a raised surface chip
// on a subtle track — the same tokens as the shared SegmentedControl, icon-only.
// It lives in the account bar at the bottom of the sidebar: across, beside the
// person's name, or stacked when the sidebar is only the team rail.
const OPTIONS: { id: ThemePreference; label: string; icon: LucideIcon }[] = [
  { id: 'system', label: 'System', icon: Monitor },
  { id: 'light', label: 'Light', icon: Sun },
  { id: 'dark', label: 'Dark', icon: Moon },
]

export function ThemeToggle({
  orientation = 'horizontal',
}: {
  orientation?: 'horizontal' | 'vertical'
} = {}) {
  const { theme, resolvedTheme, setTheme } = useTheme()

  return (
    <div
      role="radiogroup"
      aria-label="Theme"
      data-testid="theme-toggle"
      // The track is the recessed base (`bg-background`, darker than the surface it sits
      // on) so the active surface chip reads as RAISED above it in BOTH themes.
      className={[
        'flex w-fit shrink-0 items-center gap-0.5 rounded-lg border border-border bg-background p-0.5',
        orientation === 'vertical' ? 'flex-col' : '',
      ].join(' ')}
    >
      {OPTIONS.map((o) => {
        const active = o.id === theme
        const Icon = o.icon
        // System's tooltip surfaces the resolved mode (Light/Dark) it's tracking.
        const label = o.id === 'system' ? `System (${resolvedTheme})` : o.label
        return (
          <button
            key={o.id}
            type="button"
            role="radio"
            aria-checked={active}
            aria-label={`Theme: ${label}`}
            title={label}
            data-testid={`theme-option-${o.id}`}
            onClick={() => setTheme(o.id)}
            className={[
              'flex h-7 w-7 items-center justify-center rounded-md transition-all duration-150 cursor-pointer',
              active
                ? 'bg-surface text-foreground shadow-[var(--shadow-raised)]'
                : 'text-foreground/45 hover:bg-foreground/[0.05] hover:text-foreground/75',
            ].join(' ')}
          >
            <Icon size={15} strokeWidth={2} aria-hidden />
          </button>
        )
      })}
    </div>
  )
}
