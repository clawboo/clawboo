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

  return (
    <div className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-2">
      <AnimatePresence>
        {toasts.map((toast) => {
          const Icon = ICON_BY_TYPE[toast.type]
          return (
            <motion.button
              key={toast.id}
              initial={{ x: 80, opacity: 0 }}
              animate={{ x: 0, opacity: 1 }}
              exit={{ x: 80, opacity: 0 }}
              transition={{ type: 'spring', damping: 20, stiffness: 300 }}
              onClick={() => removeToast(toast.id)}
              className="flex max-w-[340px] cursor-pointer items-start gap-2.5 rounded-xl border border-border bg-surface px-4 py-3 text-left text-[13px] leading-snug text-foreground transition hover:border-border-strong"
              style={{ boxShadow: 'var(--shadow-floating)' }}
            >
              <Icon
                size={16}
                strokeWidth={2}
                aria-hidden
                className="mt-px shrink-0"
                style={{ color: ICON_COLOR_BY_TYPE[toast.type] }}
              />
              <span>{toast.message}</span>
            </motion.button>
          )
        })}
      </AnimatePresence>
    </div>
  )
}
