// Reusable spinner for in-flight async operations (Phase 6).
// Tailwind's `animate-spin` honors `prefers-reduced-motion` automatically.

import { Loader2 } from 'lucide-react'

export interface SpinnerProps {
  size?: number
  strokeWidth?: number
  className?: string
}

export function Spinner({ size = 14, strokeWidth = 2, className }: SpinnerProps) {
  return (
    <Loader2
      aria-hidden
      size={size}
      strokeWidth={strokeWidth}
      className={`animate-spin ${className ?? ''}`}
    />
  )
}
