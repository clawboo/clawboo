// The app's one modal primitive. Every overlay that dims the app behind it goes
// through this: it owns the scrim, the `role="dialog" aria-modal` panel, the
// focus trap + focus return, Escape, and the enter/exit animation — so those
// can't drift per-overlay (they had: six overlays shipped with none of them).
//
// Two shapes, one component. `variant="center"` is a card centred in the
// viewport; `variant="drawer"` is a full-height sheet pinned right. They differ
// only in the scrim's flex alignment and the panel's motion variants — every
// accessibility behaviour is identical, so splitting them would mean two places
// to fix the next dialog bug.
//
// ── Escape goes through the shared dismissable-layer stack ───────────────────
// Not a listener of its own. Every overlay in the app — this Modal, `Select`'s
// popover, `ConfirmDialog`, the context menus — registers on one stack, and a
// single listener hands Escape to the TOPMOST layer only. Ordering is explicit
// (a popover always outranks a dialog, so an open dropdown dismisses alone and
// leaves the dialog behind it standing) instead of emergent from whichever
// phase each overlay happened to pick. This replaces the previous arrangement,
// where this file bound `window` in the bubble phase specifically to lose the
// race to `Select`'s document-capture `stopPropagation()`; that only held while
// every participant guessed a compatible phase, and broke outright for the two
// overlays that both chose document-capture (issue #95).
//
// Nested modals still resolve correctly: the trap stack orders traps for focus,
// and the layer stack orders dismissal, both innermost-first.
//
// Deliberately NOT here: a portal (moving content out of RTL's `container` would
// silently weaken every `axe(container)` assertion in the repo) and a body
// scroll lock (no overlay does one today). Background `inert` is also out —
// App.tsx's inert wrapper contains ContentArea, which is where every one of
// these overlays renders from, so inerting from here would inert the modal
// itself. `aria-modal` + a working Tab trap covers the failure modes that
// matter; portalling is the prerequisite for inerting, and is a follow-up.

import { useRef } from 'react'
import type { CSSProperties, ReactNode, RefObject } from 'react'
import { AnimatePresence, motion } from 'framer-motion'
import type { Transition } from 'framer-motion'

import { ENTER_SPRING } from '@/lib/motion'
import { useDismissableLayer } from './useDismissableLayer'
import { useFocusTrap } from './useFocusTrap'

export type ModalVariant = 'center' | 'drawer'

interface ModalBaseProps {
  /** Mount/unmount the dialog. Drives AnimatePresence, the trap, and Escape. */
  open: boolean
  onClose: () => void
  variant?: ModalVariant
  /** `alertdialog` for a destructive confirmation that must interrupt. */
  role?: 'dialog' | 'alertdialog'
  /** false → Escape and scrim dismissal are ignored (a write is in flight). */
  dismissible?: boolean
  /** Stacking context. Defaults to 60; raise for a sheet opened over a modal. */
  layer?: number
  /** Re-run the focus move when this changes (e.g. a wizard step). */
  focusKey?: unknown
  /** Focus this on open instead of the panel's first focusable. */
  initialFocusRef?: RefObject<HTMLElement | null>
  /** Panel classes — width, height, padding, radius, surface, scroll. */
  panelClassName?: string
  panelStyle?: CSSProperties
  /** Extra scrim classes — e.g. `backdrop-blur-sm`, padding. */
  scrimClassName?: string
  'data-testid'?: string
  scrimTestId?: string
  children: ReactNode
}

// A dialog with no accessible name is an axe `aria-dialog-name` violation. Make
// that a compile error rather than something a test has to catch per consumer.
type ModalNaming = { labelledBy: string; label?: never } | { label: string; labelledBy?: never }

export type ModalProps = ModalBaseProps & ModalNaming

const CENTER_MOTION = {
  initial: { opacity: 0, scale: 0.96, y: 8 },
  animate: { opacity: 1, scale: 1, y: 0 },
  exit: { opacity: 0, scale: 0.97, y: 6 },
  transition: { type: 'spring', stiffness: 320, damping: 26 } as Transition,
}

const DRAWER_MOTION = {
  initial: { x: '100%' },
  animate: { x: 0 },
  exit: { x: '100%' },
  transition: ENTER_SPRING,
}

export function Modal({ open, ...rest }: ModalProps) {
  // Registered HERE and not in ModalBody: the body outlives `open` by the length
  // of its exit animation, and a layer still on the stack during that window
  // would swallow the next Escape instead of passing it to whatever is behind.
  //
  // `active: open` even when `dismissible` is false — a dialog with a write in
  // flight must still CONSUME Escape rather than let it reach the app shell,
  // which would navigate the view out from under the pending write. Owning the
  // layer with a no-op `onEscape` is what does that.
  //
  // Outside-press goes through the SAME stack, not a scrim handler. The stack
  // deliberately does not stop the press event (a press inside a dialog must
  // still activate whatever it landed on), so a local scrim handler would fire
  // in addition to the popover's dismissal — one press on the scrim would close
  // an open `<Select>` AND this dialog. Routing both channels through the stack
  // means the topmost layer, and only it, reacts.
  const { dismissible = true, onClose } = rest
  const panelRef = useRef<HTMLDivElement | null>(null)
  useDismissableLayer({
    active: open,
    level: 'dialog',
    onEscape: () => {
      if (dismissible) onClose()
    },
    contains: (t) => !!panelRef.current?.contains(t),
    onPressOutside: () => {
      if (dismissible) onClose()
    },
  })

  // The body mounts only while open, so the trap activates + restores focus on
  // the dialog's lifecycle and `children` state resets on every open by
  // construction (the NewTaskDialog pattern).
  return (
    <AnimatePresence>
      {open && <ModalBody key="modal-body" panelRef={panelRef} {...rest} />}
    </AnimatePresence>
  )
}

function ModalBody({
  label,
  labelledBy,
  variant = 'center',
  role = 'dialog',
  layer = 60,
  focusKey = 0,
  initialFocusRef,
  panelClassName = '',
  panelStyle,
  scrimClassName = '',
  'data-testid': testId,
  scrimTestId,
  children,
  panelRef,
}: Omit<ModalProps, 'open'> & { panelRef: RefObject<HTMLDivElement | null> }) {
  useFocusTrap(panelRef, focusKey, initialFocusRef)

  const drawer = variant === 'drawer'
  const m = drawer ? DRAWER_MOTION : CENTER_MOTION

  return (
    <motion.div
      // Presentational: the scrim is a dismissal click target, not a control,
      // and must not surface in the AT tree as one.
      role="presentation"
      data-testid={scrimTestId}
      className={[
        'fixed inset-0 flex',
        drawer ? 'justify-end' : 'items-center justify-center p-4',
        scrimClassName,
      ]
        .filter(Boolean)
        .join(' ')}
      style={{ background: 'var(--overlay-scrim)', zIndex: layer }}
      initial={{ opacity: 0 }}
      animate={{ opacity: 1 }}
      exit={{ opacity: 0 }}
      transition={{ duration: 0.15 }}
    >
      <motion.div
        ref={panelRef}
        role={role}
        aria-modal="true"
        {...(labelledBy ? { 'aria-labelledby': labelledBy } : { 'aria-label': label })}
        // Focusable so the trap's root fallback can land focus inside the dialog
        // on a control-less body (an element without tabindex isn't a valid
        // focus target → focus would stay on <body>).
        tabIndex={-1}
        data-testid={testId}
        className={['outline-none', drawer ? 'h-full' : '', panelClassName]
          .filter(Boolean)
          .join(' ')}
        style={panelStyle}
        initial={m.initial}
        animate={m.animate}
        exit={m.exit}
        transition={m.transition}
      >
        {children}
      </motion.div>
    </motion.div>
  )
}
