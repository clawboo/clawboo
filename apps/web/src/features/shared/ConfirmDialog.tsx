import { useEffect } from 'react'
import { AnimatePresence, motion } from 'framer-motion'

import { useConfirmStore } from '@/stores/confirm'
import { Button } from './Button'

// The design-system confirmation dialog (replaces native `window.confirm`). Mounted
// once at the app root; driven imperatively by `confirm()` / `useConfirmStore`.
// Escape / scrim cancels, Enter confirms, and the primary button auto-focuses on open.

export function ConfirmDialog() {
  const open = useConfirmStore((s) => s.open)
  const options = useConfirmStore((s) => s.options)
  const settle = useConfirmStore((s) => s.settle)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation() // don't also close a parent modal behind it
        settle(false)
      } else if (e.key === 'Enter') {
        e.preventDefault()
        settle(true)
      }
    }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open, settle])

  const danger = options?.tone === 'danger'

  return (
    <AnimatePresence>
      {open && options && (
        <motion.div
          key="confirm-scrim"
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
                autoFocus
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
  )
}
