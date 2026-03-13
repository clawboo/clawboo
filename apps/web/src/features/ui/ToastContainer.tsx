import { AnimatePresence, motion } from 'framer-motion'
import { useToastStore, type ToastType } from '@/stores/toast'

const bgByType: Record<ToastType, string> = {
  success: 'bg-[#34D399] text-[#0A0E1A]',
  error: 'bg-[#E94560] text-white',
  info: 'bg-[#111827] text-white border border-white/10',
}

export function ToastContainer() {
  const toasts = useToastStore((s) => s.toasts)
  const removeToast = useToastStore((s) => s.removeToast)

  return (
    <div className="fixed bottom-5 right-5 z-[9999] flex flex-col gap-2">
      <AnimatePresence>
        {toasts.map((toast) => (
          <motion.button
            key={toast.id}
            initial={{ x: 80, opacity: 0 }}
            animate={{ x: 0, opacity: 1 }}
            exit={{ x: 80, opacity: 0 }}
            transition={{ type: 'spring', damping: 20, stiffness: 300 }}
            onClick={() => removeToast(toast.id)}
            className={`max-w-[320px] cursor-pointer rounded-lg px-4 py-2 text-xs shadow-lg ${bgByType[toast.type]}`}
          >
            {toast.message}
          </motion.button>
        ))}
      </AnimatePresence>
    </div>
  )
}
