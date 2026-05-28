import { Moon, Sun, Monitor } from 'lucide-react'
import { useTheme } from './useTheme'
import type { ThemePreference } from './ThemeProvider'

const ORDER: ThemePreference[] = ['light', 'dark', 'system']

const LABELS: Record<ThemePreference, string> = {
  light: 'Light',
  dark: 'Dark',
  system: 'System',
}

function Icon({ theme, className }: { theme: ThemePreference; className?: string }) {
  if (theme === 'light') return <Sun className={className} strokeWidth={2} />
  if (theme === 'dark') return <Moon className={className} strokeWidth={2} />
  return <Monitor className={className} strokeWidth={2} />
}

export function ThemeToggle() {
  const { theme, resolvedTheme, setTheme } = useTheme()

  const next: ThemePreference = ORDER[(ORDER.indexOf(theme) + 1) % ORDER.length]!

  const title =
    theme === 'system'
      ? `Theme: System (${resolvedTheme}). Click for ${LABELS[next]}.`
      : `Theme: ${LABELS[theme]}. Click for ${LABELS[next]}.`

  return (
    <button
      type="button"
      data-testid="theme-toggle"
      onClick={() => setTheme(next)}
      title={title}
      aria-label={title}
      className="flex w-full items-center gap-2 rounded-md px-2.5 py-1.5 text-[11px] font-medium text-text/70 transition-all duration-150 hover:bg-foreground/5 hover:text-text/90"
    >
      <Icon theme={theme} className="h-3.5 w-3.5" />
      <span>{LABELS[theme]}</span>
      <span className="ml-auto text-[10px] uppercase tracking-wider text-secondary/60">
        {theme === 'system' ? resolvedTheme : ''}
      </span>
    </button>
  )
}
