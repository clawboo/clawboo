import { Suspense, useEffect, useMemo, useRef, useState } from 'react'
import { AnimatePresence, motion, useReducedMotion } from 'framer-motion'
import {
  Activity,
  BarChart3,
  Brain,
  Clock,
  Cpu,
  HeartPulse,
  KeyRound,
  Puzzle,
  Search,
  Settings as SettingsIcon,
  ShieldAlert,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useSettingsModalStore, type SettingsView } from '@/stores/settingsModal'
import { NAV_PANELS } from '@/features/layout/navPanels'
import { InSettingsModalContext } from './settingsModalContext'
import { Spinner } from '@/features/shared/Spinner'

interface SettingsItem {
  id: SettingsView
  label: string
  icon: LucideIcon
  /** Extra search terms so a filter matches by concept, not just label. */
  keywords?: string
}

interface SettingsGroup {
  label: string
  items: SettingsItem[]
}

// Grouped like Linear / Claude settings: config + management up top, usage /
// insights, then the raw system surfaces. The daily-driver work surfaces
// (Atlas, Fleet, Marketplace, Board, Approvals) deliberately stay in the
// sidebar — they are navigation, not settings.
const GROUPS: SettingsGroup[] = [
  {
    label: 'Workspace',
    items: [
      {
        id: 'providers',
        label: 'Providers',
        icon: KeyRound,
        keywords: 'api key anthropic openai google openrouter vault provider llm',
      },
      {
        id: 'runtimes',
        label: 'Runtimes',
        icon: Cpu,
        keywords: 'connect install claude codex hermes native openclaw',
      },
      { id: 'memory', label: 'Memory', icon: Brain, keywords: 'facts recall knowledge' },
      {
        id: 'capabilities',
        label: 'Capabilities',
        icon: Puzzle,
        keywords: 'tools skills connectors',
      },
      { id: 'scheduler', label: 'Scheduler', icon: Clock, keywords: 'routines cron schedule' },
    ],
  },
  {
    label: 'Insights',
    items: [
      {
        id: 'cost',
        label: 'Tokens Used',
        icon: BarChart3,
        keywords: 'cost usage spend budget tokens',
      },
      {
        id: 'obs',
        label: 'Observability',
        icon: Activity,
        keywords: 'traces telemetry events fleet health',
      },
      {
        id: 'governance',
        label: 'Governance',
        icon: ShieldAlert,
        keywords: 'budget audit approvals caps',
      },
    ],
  },
  {
    label: 'System',
    items: [
      {
        id: 'system',
        label: 'System',
        icon: SettingsIcon,
        keywords: 'openclaw model api key gateway maintenance',
      },
      {
        id: 'health',
        label: 'System Health',
        icon: HeartPulse,
        keywords: 'boot probe diagnostics status',
      },
    ],
  },
]

export function SettingsModal() {
  const open = useSettingsModalStore((s) => s.open)
  const view = useSettingsModalStore((s) => s.view)
  const setView = useSettingsModalStore((s) => s.setView)
  const close = useSettingsModalStore((s) => s.close)
  const [query, setQuery] = useState('')
  const reduceMotion = useReducedMotion()
  const dialogRef = useRef<HTMLDivElement>(null)
  const searchInputRef = useRef<HTMLInputElement>(null)
  const restoreFocusRef = useRef<HTMLElement | null>(null)

  // Reset the filter each time the modal opens.
  useEffect(() => {
    if (open) setQuery('')
  }, [open])

  // Accessible modal focus management: capture the trigger element FIRST (before
  // moving focus into the modal — don't use autoFocus, which would steal focus
  // before we can record the trigger), then focus the search field; return
  // focus to the trigger on close.
  useEffect(() => {
    if (!open) return
    restoreFocusRef.current = document.activeElement as HTMLElement | null
    searchInputRef.current?.focus()
    return () => {
      restoreFocusRef.current?.focus?.()
    }
  }, [open])

  // Trap Tab within the dialog so keyboard focus can't escape to the shell
  // behind the scrim.
  const handleTabTrap = (e: React.KeyboardEvent) => {
    if (e.key !== 'Tab' || !dialogRef.current) return
    const focusables = dialogRef.current.querySelectorAll<HTMLElement>(
      'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])',
    )
    if (focusables.length === 0) return
    const first = focusables[0]!
    const last = focusables[focusables.length - 1]!
    const active = document.activeElement
    if (e.shiftKey && active === first) {
      e.preventDefault()
      last.focus()
    } else if (!e.shiftKey && active === last) {
      e.preventDefault()
      first.focus()
    }
  }

  const filteredGroups = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return GROUPS
    return GROUPS.map((g) => ({
      ...g,
      items: g.items.filter(
        (it) =>
          it.label.toLowerCase().includes(q) || (it.keywords?.toLowerCase().includes(q) ?? false),
      ),
    })).filter((g) => g.items.length > 0)
  }, [query])

  return (
    <AnimatePresence>
      {open && (
        <motion.div
          key="settings-scrim"
          className="fixed inset-0 z-[70] flex items-center justify-center p-4"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          transition={{ duration: 0.15 }}
          style={{ background: 'var(--overlay-scrim)', backdropFilter: 'blur(2px)' }}
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) close()
          }}
          data-testid="settings-modal"
        >
          <motion.div
            ref={dialogRef}
            onKeyDown={handleTabTrap}
            className="surface-overlay-tier flex w-full max-w-[920px] overflow-hidden rounded-2xl"
            style={{ height: 'min(86vh, 640px)' }}
            // Opacity-only (no scale/translate): a transformed dialog would
            // become the containing block for its panels' `position: fixed`
            // sub-overlays (diagnostics drawer, schedule dialog, setup flow),
            // clipping them inside the modal box. Keeping the dialog
            // transform-free lets those overlays resolve against the viewport.
            // Duration/easing mirror the design system's --motion-emphasized.
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: reduceMotion ? 0.12 : 0.28, ease: [0.32, 0.72, 0, 1] }}
            role="dialog"
            aria-modal="true"
            aria-label="Settings"
          >
            {/* Left rail — grouped nav + search */}
            <div className="flex w-[236px] shrink-0 flex-col border-r border-border bg-foreground/[0.02]">
              <div className="px-4 pb-2 pt-4">
                <h2 className="mb-3 px-1 text-[15px] font-bold tracking-[-0.01em] text-foreground">
                  Settings
                </h2>
                <div className="relative">
                  <Search
                    size={14}
                    strokeWidth={2}
                    className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-foreground/35"
                  />
                  <input
                    ref={searchInputRef}
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search settings"
                    aria-label="Search settings"
                    className="w-full rounded-lg border border-border bg-surface py-1.5 pl-8 pr-2.5 text-[13px] text-foreground outline-none transition placeholder:text-foreground/30 focus:border-primary focus:ring-4 focus:ring-primary/15"
                  />
                </div>
              </div>
              <nav aria-label="Settings sections" className="flex-1 overflow-y-auto px-2 pb-3">
                {filteredGroups.map((g) => (
                  <div key={g.label} className="mb-1 mt-2 first:mt-0">
                    <div className="px-2.5 py-1 font-mono text-[10.5px] uppercase tracking-[0.14em] text-foreground/40">
                      {g.label}
                    </div>
                    {g.items.map((it) => {
                      const Icon = it.icon
                      const active = it.id === view
                      return (
                        <button
                          key={it.id}
                          type="button"
                          data-testid={`settings-nav-${it.id}`}
                          onClick={() => setView(it.id)}
                          aria-current={active ? 'page' : undefined}
                          className={[
                            'group flex w-full items-center gap-2.5 rounded-lg px-2.5 py-2 text-left text-[13px] transition-colors duration-150 cursor-pointer',
                            active
                              ? 'bg-primary/[0.08] font-semibold text-primary'
                              : 'font-medium text-foreground/70 hover:bg-foreground/[0.05] hover:text-foreground',
                          ].join(' ')}
                        >
                          <Icon
                            size={16}
                            strokeWidth={2}
                            className={
                              active
                                ? 'text-primary'
                                : 'text-foreground/55 group-hover:text-foreground/80'
                            }
                          />
                          {it.label}
                        </button>
                      )
                    })}
                  </div>
                ))}
                {filteredGroups.length === 0 && (
                  <div className="px-3 py-6 text-center text-[12.5px] text-foreground/40">
                    No settings match “{query.trim()}”.
                  </div>
                )}
              </nav>
            </div>

            {/* Right pane — a slim close bar over the selected panel (which
                renders its own PanelHeader title below). The close lives in its
                own row so it never collides with a panel's top-right Refresh
                action, and the pane shares the panels' `bg-background` token so
                there's no surface seam. */}
            <div className="flex min-w-0 flex-1 flex-col bg-background">
              <div className="flex h-11 shrink-0 items-center justify-end border-b border-border px-3">
                <button
                  type="button"
                  onClick={close}
                  aria-label="Close settings"
                  data-testid="settings-close"
                  className="flex h-8 w-8 cursor-pointer items-center justify-center rounded-lg text-foreground/50 transition-colors hover:bg-foreground/[0.08] hover:text-foreground"
                >
                  <X size={17} strokeWidth={2} />
                </button>
              </div>
              <InSettingsModalContext.Provider value={true}>
                <div key={view} className="flex min-h-0 flex-1 flex-col overflow-hidden">
                  {/* NAV_PANELS entries are lazy-loaded, so this surface needs its
                      own Suspense boundary — the modal renders outside
                      ContentArea's boundary (it's mounted directly under App). */}
                  <Suspense
                    fallback={
                      <div role="status" className="flex flex-1 items-center justify-center">
                        <Spinner size={20} />
                        <span className="sr-only">Loading…</span>
                      </div>
                    }
                  >
                    {NAV_PANELS[view]()}
                  </Suspense>
                </div>
              </InSettingsModalContext.Provider>
            </div>
          </motion.div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
