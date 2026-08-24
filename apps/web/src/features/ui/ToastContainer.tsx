import { AnimatePresence, motion } from 'framer-motion'
import { AlertCircle, CheckCircle2, Info, type LucideIcon } from 'lucide-react'
import { useToastStore, type ToastType } from '@/stores/toast'

// Each toast renders on a clean surface card with a leading tone icon. Tone
// colors come from tokens (mint = success, destructive = error, neutral = info).
const ICON_BY_TYPE: Record<ToastType, LucideIcon> = {
  success: CheckCircle2,
  error: AlertCircle,
  info: Info,
}

const ICON_COLOR_BY_TYPE: Record<ToastType, string> = {
  success: 'var(--mint)',
  error: 'var(--destructive)',
  info: 'rgb(var(--foreground-rgb) / 0.55)',
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)
  const announcement = useToastStore((s) => s.announcement)

  // Errors are assertive, everything else polite. An error toast auto-dismisses
  // in 3 s, and a polite announcement queues behind whatever the reader is
  // already speaking — so it can land long after the visual is gone.
  // `role="alert"` implies aria-live="assertive" + aria-atomic="true".
  const assertive = announcement?.type === 'error' ? announcement : null
  const polite = announcement && announcement.type !== 'error' ? announcement : null

  return (
    <>
      {/* Both regions are ALWAYS mounted, outside AnimatePresence. A live region
          only announces mutations to a region that was already in the AT tree,
          so one that mounts already holding its first message stays silent — and
          an AnimatePresence-driven container re-mutates on every exit, which
          re-reads toasts as they expire. The inner `key` remounts the text node
          so two identical consecutive messages still register as a change. */}
      <div className="sr-only">
        <div role="status" aria-live="polite" aria-atomic="true">
          {polite && <span key={polite.id}>{polite.text}</span>}
        </div>
        <div role="alert" aria-atomic="true">
          {assertive && <span key={assertive.id}>{assertive.text}</span>}
        </div>
      </div>

      {/* Deliberately NOT a live region — see above. Named so a screen-reader
          user can still navigate to the dismissable toasts by landmark. */}
      <div
        role="region"
        aria-label="Notifications"
        className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-2"
      >
        <AnimatePresence>
          {toasts.map((toast) => {
            const Icon = ICON_BY_TYPE[toast.type]
            return (
              <motion.div
                key={toast.id}
                initial={{ x: 80, opacity: 0 }}
                animate={{ x: 0, opacity: 1 }}
                exit={{ x: 80, opacity: 0 }}
                transition={{ type: 'spring', damping: 20, stiffness: 300 }}
                className="flex max-w-[340px] items-start gap-2.5 rounded-xl border border-border bg-surface px-4 py-3 text-left text-[13px] leading-snug text-foreground transition hover:border-border-strong"
                style={{ boxShadow: 'var(--shadow-floating)' }}
              >
                <Icon
                  size={16}
                  strokeWidth={2}
                  aria-hidden
                  className="mt-px shrink-0"
                  style={{ color: ICON_COLOR_BY_TYPE[toast.type] }}
                />
                {/* The card body stays the dismiss affordance (a plain div with a
                    button-in-button would be invalid HTML, so the body is its own
                    button and the action sits beside it). */}
                <button
                  type="button"
                  onClick={() => removeToast(toast.id)}
                  aria-label={`Dismiss notification: ${toast.message}`}
                  className="flex-1 cursor-pointer text-left"
                >
                  {toast.message}
                </button>
                {toast.action && (
                  <button
                    type="button"
                    onClick={() => {
                      // Run-then-dismiss, in that order: the handler may read the
                      // toast's own closure, and a dismissed card must never leave
                      // a pending action behind.
                      toast.action?.onAction()
                      removeToast(toast.id)
                    }}
                    className="shrink-0 rounded-lg border border-border px-2.5 py-1 text-xs font-medium text-foreground transition hover:border-border-strong hover:bg-surface-raised"
                  >
                    {toast.action.label}
                  </button>
                )}
              </motion.div>
            )
          })}
        </AnimatePresence>
      </div>
    </>
  )
}
