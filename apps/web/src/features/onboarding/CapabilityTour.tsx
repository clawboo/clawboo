import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { motion, useReducedMotion } from 'framer-motion'
import {
  ArrowRight,
  Globe,
  KanbanSquare,
  ShoppingCart,
  SlidersHorizontal,
  Users,
  X,
  type LucideIcon,
} from 'lucide-react'
import { useViewStore } from '@/stores/view'
import { useTeamStore } from '@/stores/team'
import { useSettingsModalStore } from '@/stores/settingsModal'
import { useTourStore } from '@/stores/tour'
import { CAPABILITY_TOUR_FLAG, hasSeenFlag, markSeenFlag } from '@/lib/oneTimeFlag'
import { useFocusTrap } from './useFocusTrap'

// ─── Step model ──────────────────────────────────────────────────────────────
//
// Two kinds of step:
//   • `spot`   — anchors a spotlight + coach-mark card to a real element in the
//                sidebar (found by data-testid). `enter()` reveals the matching
//                surface in the content area BEHIND the spotlight, so the user
//                actually sees each part of the app as the tour walks them
//                through it.
//   • `center` — a framed hero card (Welcome / You're-all-set) with the Boo
//                mascot; dims the whole shell, no anchor.

interface SpotStep {
  kind: 'spot'
  key: string
  /** data-testid of the sidebar element to spotlight. */
  target: string
  eyebrow: string
  title: string
  body: string
  icon: LucideIcon
  /** Reveal the matching surface behind the spotlight. */
  enter?: () => void
  /** Extra px of breathing room around the target in the cutout. */
  pad?: number
  /** Corner radius of the cutout (matches the target's own rounding). */
  radius?: number
}

interface CenterStep {
  kind: 'center'
  key: string
  variant: 'welcome' | 'finish'
  title: string
  body: string
  enter?: () => void
}

type Step = SpotStep | CenterStep

const nav = () => useViewStore.getState()

const STEPS: Step[] = [
  {
    kind: 'center',
    key: 'welcome',
    variant: 'welcome',
    title: 'Welcome to Clawboo',
    body: "Your Boos are AI agents that work together as a team. Take the 60-second tour and we'll show you around.",
  },
  {
    kind: 'spot',
    key: 'fleet',
    // The agent-list region (Group Chat + Boo rows), not the whole column — so
    // this step doesn't pre-highlight the nav items the later stops zoom into.
    // Absent (collapsed column / Boo Zero view) → the step centres gracefully.
    target: 'fleet-agent-list',
    eyebrow: 'Your team',
    title: 'Meet your Boos',
    body: 'Every agent on your team lives here. Click a Boo to chat one-to-one, or open Group Chat to brief the whole room at once.',
    icon: Users,
    pad: 6,
    radius: 14,
  },
  {
    kind: 'spot',
    key: 'atlas',
    target: 'nav-graph',
    eyebrow: 'Atlas',
    title: 'See the whole org',
    body: 'Atlas maps every team and how your agents connect: one live, cross-team org-graph.',
    icon: Globe,
    enter: () => nav().navigateTo('graph'),
  },
  {
    kind: 'spot',
    key: 'board',
    target: 'nav-board',
    eyebrow: 'Board',
    title: 'Watch work flow',
    body: "As your team collaborates, the work shows up here as tasks and moves toward done: a durable record of who's doing what.",
    icon: KanbanSquare,
    enter: () => nav().navigateTo('board'),
  },
  {
    kind: 'spot',
    key: 'marketplace',
    target: 'nav-marketplace',
    eyebrow: 'Marketplace',
    title: 'Hire in a click',
    body: 'Browse hundreds of ready-made agents and full team templates. Deploy one and it joins your fleet instantly.',
    icon: ShoppingCart,
    enter: () => nav().navigateTo('marketplace'),
  },
  {
    kind: 'spot',
    key: 'runtimes',
    target: 'nav-settings',
    eyebrow: 'Runtimes',
    title: 'Mix your runtimes',
    body: 'Connect Claude Code, Codex, Hermes, or an OpenClaw Gateway in Settings, then mix them together on a single team.',
    icon: SlidersHorizontal,
  },
  {
    kind: 'center',
    key: 'finish',
    variant: 'finish',
    title: "You're all set",
    body: "Open Group Chat and tell Boo Zero what you need. It delegates to the right Boos and coordinates the work for you.",
  },
]

// ─── Geometry ────────────────────────────────────────────────────────────────

interface Rect {
  top: number
  left: number
  width: number
  height: number
}

function measure(selector: string): Rect | null {
  const el = document.querySelector(`[data-testid="${selector}"]`)
  if (!el) return null
  const r = el.getBoundingClientRect()
  if (r.width === 0 && r.height === 0) return null
  return { top: r.top, left: r.left, width: r.width, height: r.height }
}

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi)

const CARD_W = 380
const GAP = 18 // distance from the spotlight edge to the card
const MARGIN = 16 // min distance from any viewport edge

type Placement = 'right' | 'left' | 'below' | 'above' | 'center'

interface CardPos {
  left: number
  top: number
  placement: Placement
  /** Arrow offset from the card's leading edge, aligned to the target centre. */
  arrow: number
}

/** Vertical position that keeps a `cardH`-tall card fully on screen. */
const clampTop = (raw: number, cardH: number, vh: number): number =>
  clamp(raw, MARGIN, Math.max(MARGIN, vh - cardH - MARGIN))

/**
 * Place the coach-mark card next to the spotlight. Sidebar anchors sit far left,
 * so `right` wins in the common case; side placement is only chosen when the card
 * GENUINELY fits (the shell has no horizontal scroll to absorb overflow), else it
 * flips below/above the target. Every axis is clamped so the card — and its
 * controls — can never land off-screen. The arrow is pinned to the target's
 * centre, clamped so it never slides off the card edge.
 */
function placeSpot(rect: Rect, cardW: number, cardH: number, vw: number, vh: number): CardPos {
  const cx = rect.left + rect.width / 2
  const cy = rect.top + rect.height / 2

  if (rect.left + rect.width + GAP + cardW + MARGIN <= vw) {
    const top = clampTop(cy - cardH / 2, cardH, vh)
    return {
      left: rect.left + rect.width + GAP,
      top,
      placement: 'right',
      arrow: clamp(cy - top, 22, cardH - 22),
    }
  }
  if (rect.left - GAP - cardW - MARGIN >= 0) {
    const top = clampTop(cy - cardH / 2, cardH, vh)
    return {
      left: rect.left - GAP - cardW,
      top,
      placement: 'left',
      arrow: clamp(cy - top, 22, cardH - 22),
    }
  }
  // Narrow viewport: flip below the target, or above if there's no room below.
  const left = clamp(cx - cardW / 2, MARGIN, Math.max(MARGIN, vw - cardW - MARGIN))
  const belowFits = rect.top + rect.height + GAP + cardH + MARGIN <= vh
  const aboveFits = rect.top - GAP - cardH - MARGIN >= 0
  if (belowFits || !aboveFits) {
    return {
      left,
      top: clampTop(rect.top + rect.height + GAP, cardH, vh),
      placement: 'below',
      arrow: clamp(cx - left, 22, cardW - 22),
    }
  }
  return {
    left,
    top: clampTop(rect.top - GAP - cardH, cardH, vh),
    placement: 'above',
    arrow: clamp(cx - left, 22, cardW - 22),
  }
}

function placeCenter(cardW: number, cardH: number, vw: number, vh: number): CardPos {
  return {
    left: Math.max(MARGIN, (vw - cardW) / 2),
    top: clampTop((vh - cardH) / 2, cardH, vh),
    placement: 'center',
    arrow: 0,
  }
}

// ─── Presentation ────────────────────────────────────────────────────────────

const muted = (o: number): string => `rgb(var(--foreground-rgb) / ${o})`

const TITLE_ID = 'clawboo-tour-title'
const DESC_ID = 'clawboo-tour-desc'

/** Ghost-lobster brand mascot, used on the framed Welcome / finish cards. */
function BooMascot({ size = 60 }: { size?: number }) {
  return (
    <span
      aria-hidden
      className="relative flex items-center justify-center"
      style={{ width: size + 22, height: size + 22 }}
    >
      <span
        className="absolute inset-0 rounded-full"
        style={{ background: 'rgb(var(--primary-rgb) / 0.1)', filter: 'blur(3px)' }}
      />
      <motion.img
        src="/logo.svg"
        alt=""
        width={size}
        height={size * 0.92}
        className="relative"
        style={{ filter: 'drop-shadow(0 6px 16px rgb(var(--primary-rgb) / 0.26))' }}
        initial={{ scale: 0.8, rotate: -6 }}
        animate={{ scale: 1, rotate: 0 }}
        transition={{ type: 'spring', stiffness: 240, damping: 15 }}
      />
    </span>
  )
}

/** Segmented progress rail shared by every step (decorative; position is
 *  exposed to assistive tech via the live region instead). */
function ProgressRail({ step, total }: { step: number; total: number }) {
  return (
    <div className="flex items-center gap-1.5" aria-hidden>
      {Array.from({ length: total }).map((_, i) => (
        <span
          key={i}
          className="h-1 flex-1 overflow-hidden rounded-full"
          style={{ background: muted(0.1) }}
        >
          <motion.span
            className="block h-full rounded-full"
            style={{ background: 'var(--primary)' }}
            initial={false}
            animate={{ width: i <= step ? '100%' : '0%' }}
            transition={{ duration: 0.35, ease: [0.32, 0.72, 0, 1] }}
          />
        </span>
      ))}
    </div>
  )
}

// ─── CapabilityTour ──────────────────────────────────────────────────────────

/**
 * A one-time, interactive capability tour shown after the user lands on the
 * settled dashboard. Instead of a single static popup, it spotlights each part
 * of the app in turn — dimming the shell, ringing the real sidebar control in
 * brand red, revealing the matching surface behind it, and gliding a single
 * coach-mark card from anchor to anchor — so the walkthrough happens IN the
 * product.
 *
 * Auto-opens once (keyed off `clawboo.tour.shown`) when `show` is true. The
 * caller passes `isConnected && !showBooTip` so it never collides with the
 * post-onboarding "meet your team" tip; while it runs it flips `useTourStore`
 * so the standing FirstRunNudge yields the dashboard.
 *
 * The overlay lives in a child (`TourOverlay`) that mounts only while open, so
 * the focus trap moves focus in on open and restores it on close via the normal
 * mount/unmount lifecycle (this outer component is rendered persistently).
 */
export function CapabilityTour({ show }: { show: boolean }) {
  const setTourActive = useTourStore((s) => s.setActive)
  const [open, setOpen] = useState(false)

  // Auto-open once.
  useEffect(() => {
    if (!show) return
    if (hasSeenFlag(CAPABILITY_TOUR_FLAG)) return
    setOpen(true)
  }, [show])

  // Broadcast liveness so the FirstRunNudge yields while the tour runs.
  useEffect(() => {
    setTourActive(open)
    return () => setTourActive(false)
  }, [open, setTourActive])

  const finish = useCallback((): void => {
    markSeenFlag(CAPABILITY_TOUR_FLAG)
    setOpen(false)
  }, [])

  if (!open) return null
  return <TourOverlay onClose={finish} />
}

// ─── TourOverlay (mounts only while open) ─────────────────────────────────────

function TourOverlay({ onClose }: { onClose: () => void }) {
  const openSettings = useSettingsModalStore((s) => s.openSettings)
  const reduce = useReducedMotion()

  const [step, setStep] = useState(0)
  const [rect, setRect] = useState<Rect | null>(null)
  const [vp, setVp] = useState(() => ({
    w: typeof window === 'undefined' ? 1280 : window.innerWidth,
    h: typeof window === 'undefined' ? 800 : window.innerHeight,
  }))

  const cardRef = useRef<HTMLDivElement | null>(null)
  const [cardH, setCardH] = useState(240)

  // Mount==open, so this moves focus into the dialog on open and restores it to
  // the pre-tour element on close (unmount). `step` re-runs the focus move only
  // when focus has left the card.
  useFocusTrap(cardRef, step)

  const total = STEPS.length
  const current = STEPS[step]
  const isLast = step === total - 1

  // Run the step's reveal side-effect, then measure its anchor. Sidebar anchors
  // don't move when the content area navigates, so a rAF settle is enough; we
  // still re-measure on resize / scroll below.
  useLayoutEffect(() => {
    current.enter?.()
    if (current.kind !== 'spot') {
      setRect(null)
      return
    }
    const target = current.target
    const sync = (): void => setRect(measure(target))
    sync()
    const raf = window.requestAnimationFrame(sync)
    const t = window.setTimeout(sync, 120)
    return () => {
      window.cancelAnimationFrame(raf)
      window.clearTimeout(t)
    }
  }, [current])

  // Keep the spotlight + card glued through resize / scroll.
  useEffect(() => {
    const sync = (): void => {
      setVp({ w: window.innerWidth, h: window.innerHeight })
      if (current.kind === 'spot') setRect(measure(current.target))
    }
    window.addEventListener('resize', sync)
    window.addEventListener('scroll', sync, true)
    return () => {
      window.removeEventListener('resize', sync)
      window.removeEventListener('scroll', sync, true)
    }
  }, [current])

  // Measure the card so placement can centre it on the target.
  useLayoutEffect(() => {
    if (cardRef.current) setCardH(cardRef.current.offsetHeight)
  }, [step, rect, vp])

  // Esc closes the tour.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault()
        onClose()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const goNext = (): void => (isLast ? onClose() : setStep((s) => s + 1))
  const goBack = (): void => setStep((s) => Math.max(0, s - 1))

  const spring = reduce
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 340, damping: 34, mass: 0.7 }

  // A `spot` step whose anchor couldn't be found (collapsed column, jsdom, etc.)
  // degrades to a centred card so the tour never dead-ends.
  const anchored = current.kind === 'spot' && rect !== null
  const cardW = Math.min(CARD_W, vp.w - 2 * MARGIN)
  const cutPad = current.kind === 'spot' ? (current.pad ?? 4) : 4
  const cutRadius = current.kind === 'spot' ? (current.radius ?? 12) : 12
  const cut = anchored
    ? {
        top: rect!.top - cutPad,
        left: rect!.left - cutPad,
        width: rect!.width + cutPad * 2,
        height: rect!.height + cutPad * 2,
      }
    : null
  const pos = anchored
    ? placeSpot(rect!, cardW, cardH, vp.w, vp.h)
    : placeCenter(cardW, cardH, vp.w, vp.h)
  const sideArrow = pos.placement === 'right' || pos.placement === 'left'

  return (
    <motion.div
      className="fixed inset-0 z-[70]"
      data-testid="capability-tour"
      role="dialog"
      aria-modal="true"
      aria-labelledby={TITLE_ID}
      aria-describedby={DESC_ID}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      transition={{ duration: reduce ? 0 : 0.2 }}
    >
      {/* Polite announcement of each step for assistive tech — the card is a
          single persistent element that swaps content in place, so a live region
          is what surfaces the transition + position to a screen reader. */}
      <div aria-live="polite" role="status" className="sr-only">
        {`Step ${step + 1} of ${total}. ${current.title}. ${current.body}`}
      </div>

      {/* Click-blocker — swallows interaction with the app behind the tour. The
          dim area is inert (explicit controls only) so a stray click can't skip
          the whole tour. On centred steps it also paints the full-screen scrim
          (no cutout to dim around). */}
      <div
        className="absolute inset-0"
        onClick={(e) => e.stopPropagation()}
        style={anchored ? undefined : { background: 'var(--overlay-scrim)' }}
      />

      {/* Spotlight cutout — the huge box-shadow dims everything OUTSIDE the rect;
          the second layer paints a brand ring + glow around the hole. */}
      {cut && (
        <>
          <motion.div
            className="pointer-events-none absolute"
            initial={false}
            animate={cut}
            transition={spring}
            style={{
              borderRadius: cutRadius,
              boxShadow: '0 0 0 9999px var(--overlay-scrim)',
            }}
          />
          <motion.div
            className="pointer-events-none absolute"
            initial={false}
            animate={cut}
            transition={spring}
            style={{
              borderRadius: cutRadius,
              boxShadow:
                '0 0 0 1.5px var(--primary), 0 0 0 6px rgb(var(--primary-rgb) / 0.2), 0 0 24px 2px rgb(var(--primary-rgb) / 0.28)',
            }}
          />
        </>
      )}

      {/* Coach-mark card — a single element that glides between anchors. No
          `overflow-hidden`: the arrow protrudes past the card edge toward the
          spotlight, and the padded content never reaches the rounded corners. */}
      <motion.div
        ref={cardRef}
        initial={{ opacity: 0, scale: 0.96, top: pos.top, left: pos.left }}
        animate={{ opacity: 1, scale: 1, top: pos.top, left: pos.left }}
        transition={spring}
        className="absolute rounded-2xl border border-border bg-surface"
        style={{ width: cardW, boxShadow: 'var(--shadow-overlay)' }}
        onClick={(e) => e.stopPropagation()}
      >
        {/* Arrow — points from the card toward the spotlight. */}
        {sideArrow && (
          <span
            aria-hidden
            className="absolute h-3 w-3 rotate-45 bg-surface"
            style={{
              top: pos.arrow - 6,
              [pos.placement === 'right' ? 'left' : 'right']: -6,
              borderStyle: 'solid',
              borderColor: 'var(--border)',
              borderLeftWidth: pos.placement === 'right' ? 1 : 0,
              borderBottomWidth: pos.placement === 'right' ? 1 : 0,
              borderTopWidth: pos.placement === 'left' ? 1 : 0,
              borderRightWidth: pos.placement === 'left' ? 1 : 0,
            }}
          />
        )}

        {current.kind === 'center' ? (
          <CenterBody
            step={current}
            index={step}
            total={total}
            isLast={isLast}
            onNext={goNext}
            onSkip={onClose}
            onFinish={() => {
              // The finish CTA drops the user into Group Chat with their team's
              // leader (Boo Zero), the working "brief the team and it delegates"
              // surface. Fall back to the first team; if none exists, just close.
              const teamStore = useTeamStore.getState()
              const teamId = teamStore.selectedTeamId ?? teamStore.teams[0]?.id ?? null
              if (teamId) nav().openGroupChat(teamId)
              onClose()
            }}
          />
        ) : (
          <SpotBody
            step={current}
            index={step}
            total={total}
            isLast={isLast}
            onNext={goNext}
            onBack={goBack}
            onSkip={onClose}
            // Diving into Settings ends the tour — otherwise the Settings modal
            // would open UNDER the z-70 tour overlay. React batches both updates
            // so there's no flash of the modal behind the tour.
            onOpenSettings={() => {
              onClose()
              openSettings('runtimes')
            }}
          />
        )}

        <button
          type="button"
          onClick={onClose}
          aria-label="Close tour"
          className="absolute right-3 top-3 rounded-lg p-1.5 text-foreground/35 transition-colors hover:bg-foreground/[0.06] hover:text-foreground/70"
        >
          <X className="h-4 w-4" strokeWidth={2} />
        </button>
      </motion.div>
    </motion.div>
  )
}

// ─── Card bodies ─────────────────────────────────────────────────────────────

function CenterBody({
  step,
  index,
  total,
  isLast,
  onNext,
  onSkip,
  onFinish,
}: {
  step: CenterStep
  index: number
  total: number
  isLast: boolean
  onNext: () => void
  onSkip: () => void
  onFinish: () => void
}) {
  return (
    <div className="px-7 pb-6 pt-8">
      <div className="flex flex-col items-center text-center">
        <BooMascot size={62} />
        <h2
          id={TITLE_ID}
          className="mt-4 font-display text-[22px]"
          style={{ color: 'var(--foreground)', fontWeight: 800, letterSpacing: '-0.02em' }}
        >
          {step.title}
        </h2>
        <p
          id={DESC_ID}
          className="mt-2 max-w-[300px] text-[13.5px] leading-relaxed"
          style={{ color: muted(0.62) }}
        >
          {step.body}
        </p>
      </div>

      <div className="mt-6">
        <ProgressRail step={index} total={total} />
      </div>

      <div className="mt-5 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onSkip}
          data-testid="tour-skip"
          className="text-[13px] font-medium text-foreground/50 transition-colors hover:text-foreground/80"
        >
          {step.variant === 'welcome' ? 'Skip tour' : 'Close'}
        </button>
        {step.variant === 'finish' ? (
          <button
            type="button"
            onClick={onFinish}
            data-testid="tour-open-chat"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm transition hover:brightness-[1.06] active:scale-[0.98]"
          >
            Open Group Chat <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />
          </button>
        ) : (
          <button
            type="button"
            onClick={onNext}
            data-testid="tour-next"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-4 py-2 text-[13px] font-semibold text-primary-foreground shadow-sm transition hover:brightness-[1.06] active:scale-[0.98]"
          >
            {isLast ? 'Done' : 'Start tour'}
            <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />
          </button>
        )}
      </div>
    </div>
  )
}

function SpotBody({
  step,
  index,
  total,
  isLast,
  onNext,
  onBack,
  onSkip,
  onOpenSettings,
}: {
  step: SpotStep
  index: number
  total: number
  isLast: boolean
  onNext: () => void
  onBack: () => void
  onSkip: () => void
  onOpenSettings: () => void
}) {
  const Icon = step.icon
  const isRuntimes = step.key === 'runtimes'
  return (
    <div className="px-6 pb-5 pt-6">
      <div className="flex items-start gap-3.5">
        <span
          aria-hidden
          className="flex h-11 w-11 shrink-0 items-center justify-center rounded-xl"
          style={{ background: 'rgb(var(--primary-rgb) / 0.12)' }}
        >
          <Icon className="h-[22px] w-[22px] text-primary" strokeWidth={1.9} />
        </span>
        <div className="min-w-0 pt-0.5">
          <p
            className="font-mono text-[10px] font-semibold uppercase tracking-[0.14em]"
            style={{ color: 'var(--primary)' }}
          >
            {step.eyebrow}
          </p>
          <h2
            id={TITLE_ID}
            className="mt-1 font-display text-[17px] leading-tight"
            style={{ color: 'var(--foreground)', fontWeight: 750, letterSpacing: '-0.015em' }}
          >
            {step.title}
          </h2>
        </div>
      </div>

      <p id={DESC_ID} className="mt-3 text-[13px] leading-relaxed" style={{ color: muted(0.64) }}>
        {step.body}
      </p>

      {isRuntimes && (
        <button
          type="button"
          onClick={onOpenSettings}
          className="mt-3 inline-flex items-center gap-1.5 text-[12.5px] font-semibold text-primary transition-colors hover:text-primary/80"
        >
          Open Settings → Runtimes <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />
        </button>
      )}

      <div className="mt-5">
        <ProgressRail step={index} total={total} />
      </div>

      <div className="mt-4 flex items-center justify-between gap-2">
        <button
          type="button"
          onClick={onSkip}
          data-testid="tour-skip"
          className="text-[12.5px] font-medium text-foreground/45 transition-colors hover:text-foreground/75"
        >
          Skip tour
        </button>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={onBack}
            data-testid="tour-back"
            className="rounded-lg border border-border px-3 py-1.5 text-[12.5px] font-medium text-foreground/75 transition-colors hover:bg-foreground/[0.05]"
          >
            Back
          </button>
          <button
            type="button"
            onClick={onNext}
            data-testid="tour-next"
            className="inline-flex items-center gap-1.5 rounded-lg bg-primary px-3.5 py-1.5 text-[12.5px] font-semibold text-primary-foreground shadow-sm transition hover:brightness-[1.06] active:scale-[0.98]"
          >
            {isLast ? 'Done' : 'Next'}
            {!isLast && <ArrowRight className="h-3.5 w-3.5" strokeWidth={2.25} />}
          </button>
        </div>
      </div>
    </div>
  )
}
