// Reusable spinner for in-flight async operations.

import { Loader2, LoaderCircle } from 'lucide-react'
import { useReducedMotion } from 'framer-motion'

export interface SpinnerProps {
  size?: number
  strokeWidth?: number
  className?: string
}

export function Spinner({ size = 14, strokeWidth = 2, className }: SpinnerProps) {
  const reduce = useReducedMotion()

  // Under `prefers-reduced-motion`, the global `* { animation-duration: 0.001ms }`
  // rule in globals.css freezes `animate-spin` mid-rotation — Loader2's partial
  // arc then reads as a broken half-circle. Swap to a static full ring, which
  // still reads as "busy" without any motion.
  if (reduce) {
    return (
      <LoaderCircle
        aria-hidden
        size={size}
        strokeWidth={strokeWidth}
        className={className}
        style={{ opacity: 0.6 }}
      />
    )
  }

  return (
    <Loader2
      aria-hidden
      size={size}
      strokeWidth={strokeWidth}
      className={`animate-spin ${className ?? ''}`}
    />
  )
}
