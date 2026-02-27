'use client'

/**
 * apps/web/src/features/onboarding/BooTip.tsx
 *
 * Floating tooltip shown immediately after the onboarding wizard exits.
 * Appears next to the fleet sidebar, pointing at the first Boo agent.
 * Auto-dismisses after 4 seconds; also dismisses on click.
 */

import { useEffect } from 'react'
import { motion } from 'framer-motion'

export type BooTipProps = {
  onDismiss: () => void
}

export function BooTip({ onDismiss }: BooTipProps) {
  useEffect(() => {
    const timer = setTimeout(onDismiss, 4_000)
    return () => clearTimeout(timer)
  }, [onDismiss])

  return (
    <motion.button
      type="button"
      onClick={onDismiss}
      // w-64 sidebar (256px) + 1px border + 12px gap = 269px
      // 40px tab bar + ~52px sidebar header = ~92px from top
      initial={{ opacity: 0, x: -16, scale: 0.93 }}
      animate={{ opacity: 1, x: 0, scale: 1 }}
      exit={{ opacity: 0, x: -12, scale: 0.95 }}
      transition={{ type: 'spring', stiffness: 300, damping: 26, delay: 0.35 }}
      className="fixed left-[269px] top-[92px] z-40 flex items-center gap-3 rounded-xl border border-accent/30 bg-surface px-4 py-3 text-left shadow-[0_8px_36px_rgba(0,0,0,0.55)] cursor-pointer hover:border-accent/50 transition-colors"
      aria-label="Dismiss tip"
    >
      {/* Arrow pointing left toward the sidebar */}
      <div
        className="absolute right-full top-1/2 -translate-y-1/2"
        style={{
          width: 0,
          height: 0,
          borderTop: '5px solid transparent',
          borderBottom: '5px solid transparent',
          borderRight: '7px solid rgba(233, 69, 96, 0.30)',
        }}
      />

      <span className="text-[20px] select-none leading-none">👻</span>

      <div>
        <p className="text-[12.5px] font-medium text-text leading-tight">
          Click a Boo to start chatting
        </p>
        <p className="text-[10px] text-secondary/45 mt-0.5 font-mono">Click anywhere to dismiss</p>
      </div>
    </motion.button>
  )
}
