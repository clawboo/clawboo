import { useEffect, useRef, type RefObject } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

import { useConfirmStore } from '@/stores/confirm'
import { useDismissableLayer } from './useDismissableLayer'
import { useFocusTrap } from './useFocusTrap'
import { Button } from './Button'

// The design-system confirmation dialog (replaces native `window.confirm`). Mounted
// once at the app root; driven imperatively by `confirm()` / `useConfirmStore`.
// Escape / scrim cancels, Enter confirms. Focus moves to the primary button on open,
// Tab stays inside while it is open, and focus goes back to whatever had it before
// the moment the dialog closes.

/**
 * Focus for one opening of the dialog. It is rendered only while the dialog is open,
 * outside the AnimatePresence that keeps the panel on screen through its exit, so it
 * unmounts the moment the dialog closes and the trap hands focus back then, not after
 * the exit animation. The trap captures the element that had focus as it mounts, which
 * is why the primary button is focused by the trap (a frame later) and not by
 * `autoFocus` (during the commit, before the trap could see what had focus).
 */
function ConfirmFocus({
  panelRef,
  okRef,
}: {
  panelRef: RefObject<HTMLDivElement | null>
  okRef: RefObject<HTMLButtonElement | null>
}) {
  useFocusTrap(panelRef, null, okRef)
  return null
}

export function ConfirmDialog() {
  const open = useConfirmStore((s) => s.open)
  const options = useConfirmStore((s) => s.options)
  const settle = useConfirmStore((s) => s.settle)

  // Escape goes through the shared layer stack — this dialog is opened ON TOP of
  // whatever asked for the confirmation, so it must take Escape from the dialog
  // behind it. Being the most recently pushed layer is what does that now; it
  // used to rely on document-capture + stopPropagation, which could not suppress
  // a same-phase sibling (issue #95).
  //
  // Presses go through the same stack, and this dialog has to claim them too.
  // Otherwise a press on it (Cancel included) reaches the dialog that asked for
  // the confirmation as a press outside that dialog, and closes it. The whole
  // scrim counts as inside: a press on it cancels through its own handler below.
  const scrimRef = useRef<HTMLDivElement | null>(null)
  useDismissableLayer({
    active: open,
    level: 'dialog',
    onEscape: () => settle(false),
    contains: (target) => !!scrimRef.current?.contains(target),
    onPressOutside: () => undefined,
  })

  // Enter keeps a listener of its own: the stack arbitrates dismissal, not
  // confirmation. preventDefault stops the focused button's native activation
  // from also firing and settling twice.
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Enter') return
      // Same two contracts the stack applies to Escape, since this listener now
      // sits in the same phase: an Enter that commits an IME composition is not
      // a confirmation, and a handler nearer the target that already consumed it
      // wins. (`keyCode === 229` is the WebKit spelling that leaves
      // `isComposing` unset.)
      if (e.isComposing || e.keyCode === 229) return
      if (e.defaultPrevented) return
      e.preventDefault()
      settle(true)
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [open, settle])

  const danger = options?.tone === 'danger'
  const panelRef = useRef<HTMLDivElement | null>(null)
  const okRef = useRef<HTMLButtonElement | null>(null)

  return (
    <>
      {open && options ? <ConfirmFocus panelRef={panelRef} okRef={okRef} /> : null}
      <AnimatePresence>
        {open && options && (
          <motion.div
            key="confirm-scrim"
            ref={scrimRef}
            className="fixed inset-0 z-[90] flex items-center justify-center p-4"
            style={{ background: 'var(--overlay-scrim)' }}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.15 }}
            role="presentation"
            onMouseDown={(e) => {
              if (e.target === e.currentTarget) settle(false)
            }}
          >
            <motion.div
              ref={panelRef}
              role="alertdialog"
              aria-modal="true"
              aria-label={options.title ?? options.message}
              data-testid="confirm-dialog"
              className="surface-overlay-tier w-full max-w-[380px] rounded-2xl p-5"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.97, y: 6 }}
              transition={{ type: 'spring', stiffness: 320, damping: 26 }}
            >
              {options.title && (
                <h2
                  className="text-[15px] font-semibold text-foreground"
                  style={{ letterSpacing: '-0.01em' }}
                >
                  {options.title}
                </h2>
              )}
              <p
                className={`text-[13px] leading-relaxed text-foreground/70 ${options.title ? 'mt-1.5' : ''}`}
              >
                {options.message}
              </p>
              <div className="mt-5 flex justify-end gap-2">
                <Button
                  variant="secondary"
                  size="sm"
                  onClick={() => settle(false)}
                  data-testid="confirm-cancel"
                >
                  {options.cancelLabel ?? 'Cancel'}
                </Button>
                <Button
                  ref={okRef}
                  variant={danger ? 'danger' : 'primary'}
                  size="sm"
                  onClick={() => settle(true)}
                  data-testid="confirm-ok"
                >
                  {options.confirmLabel ?? 'Confirm'}
                </Button>
              </div>
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </>
  )
}
