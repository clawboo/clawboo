import { useEffect, useState } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import { Cpu, Globe, LayoutGrid, ShoppingCart, X, type LucideIcon } from 'lucide-react'
import { useViewStore, type NavView } from '@/stores/view'
import { useSettingsModalStore, isSettingsView } from '@/stores/settingsModal'
import { CAPABILITY_TOUR_FLAG, hasSeenFlag, markSeenFlag } from '@/lib/oneTimeFlag'

interface TourStep {
  nav: NavView
  title: string
  body: string
  icon: LucideIcon
}

const STEPS: TourStep[] = [
  {
    nav: 'runtimes',
    title: 'Runtimes',
    body: 'Connect Claude Code, Codex, Hermes, or an OpenClaw Gateway — then mix them on a single team.',
    icon: Cpu,
  },
  {
    nav: 'marketplace',
    title: 'Marketplace',
    body: 'Browse hundreds of ready-made agents and team templates. Deploy one in a click.',
    icon: ShoppingCart,
  },
  {
    nav: 'graph',
    title: 'Atlas',
    body: 'See every team and how your agents connect in one live org-graph.',
    icon: Globe,
  },
  {
    nav: 'board',
    title: 'Board',
    body: 'Watch tasks flow as your team delegates and completes work — the durable source of truth.',
    icon: LayoutGrid,
  },
]

/**
 * A lightweight, dismissible, ONE-TIME capability tour shown after the user lands
 * in the dashboard. Auto-opens once (keyed off `clawboo.tour.shown`) when `show`
 * is true — the caller passes `isConnected && !showBooTip` so it never collides
 * with the post-onboarding "meet your team" tip.
 */
export function CapabilityTour({ show }: { show: boolean }) {
  const navigateTo = useViewStore((s) => s.navigateTo)
  const openSettings = useSettingsModalStore((s) => s.openSettings)
  const [open, setOpen] = useState(false)
  const [step, setStep] = useState(0)

  useEffect(() => {
    if (!show) return
    if (hasSeenFlag(CAPABILITY_TOUR_FLAG)) return
    setOpen(true)
  }, [show])

  const finish = (): void => {
    markSeenFlag(CAPABILITY_TOUR_FLAG)
    setOpen(false)
  }

  const current = STEPS[step]
  if (!open || !current) return null
  const isLast = step === STEPS.length - 1
  const Icon = current.icon

  return (
    <AnimatePresence>
      <motion.div
        key="capability-tour-backdrop"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        className="fixed inset-0 z-50 flex items-center justify-center bg-foreground/40 backdrop-blur-sm"
        onClick={finish}
        data-testid="capability-tour"
      >
        <motion.div
          initial={{ opacity: 0, scale: 0.96, y: 8 }}
          animate={{ opacity: 1, scale: 1, y: 0 }}
          exit={{ opacity: 0, scale: 0.96, y: 8 }}
          transition={{ type: 'spring', stiffness: 280, damping: 26 }}
          className="relative w-full max-w-[400px] rounded-2xl border border-border bg-surface p-7"
          style={{ boxShadow: 'var(--shadow-overlay)' }}
          onClick={(e) => e.stopPropagation()}
        >
          <button
            type="button"
            onClick={finish}
            className="absolute right-3.5 top-3.5 rounded-lg p-1.5 text-foreground/35 transition-colors hover:text-foreground/70"
            aria-label="Close tour"
          >
            <X className="h-4 w-4" strokeWidth={2} />
          </button>

          <div className="flex items-center gap-1.5">
            {STEPS.map((_, i) => (
              <span
                key={i}
                className="h-1.5 flex-1 rounded-full transition-colors"
                style={{
                  background: i <= step ? 'var(--primary)' : 'rgb(var(--foreground-rgb) / 0.12)',
                }}
              />
            ))}
          </div>

          <div
            className="mt-6 flex h-12 w-12 items-center justify-center rounded-2xl"
            style={{ background: 'rgb(var(--primary-rgb) / 0.12)' }}
          >
            <Icon className="h-6 w-6 text-primary" strokeWidth={1.75} />
          </div>

          <h2
            className="mt-4 font-display text-[21px] tracking-tight"
            style={{ color: 'var(--foreground)', fontWeight: 800, letterSpacing: '-0.02em' }}
          >
            {current.title}
          </h2>
          <p
            className="mt-1.5 text-[13.5px] leading-relaxed"
            style={{ color: 'rgb(var(--foreground-rgb) / 0.62)' }}
          >
            {current.body}
          </p>

          <div className="mt-7 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={finish}
              className="text-[13px] font-medium text-foreground/50 transition-colors hover:text-foreground/80"
              data-testid="tour-skip"
            >
              Skip tour
            </button>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={() => {
                  // Settings-hosted surfaces (e.g. Runtimes) open the Settings
                  // modal; sidebar surfaces navigate the content area.
                  if (isSettingsView(current.nav)) openSettings(current.nav)
                  else navigateTo(current.nav)
                  finish()
                }}
                className="rounded-lg border border-border px-3.5 py-2 text-[13px] font-medium text-foreground/80 transition-colors hover:bg-foreground/[0.05]"
              >
                Take me there
              </button>
              <button
                type="button"
                onClick={() => (isLast ? finish() : setStep((s) => s + 1))}
                className="rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground transition hover:brightness-[1.06] active:scale-[0.98]"
                data-testid="tour-next"
              >
                {isLast ? 'Done' : 'Next'}
              </button>
            </div>
          </div>
        </motion.div>
      </motion.div>
    </AnimatePresence>
  )
}
