// Reusable skeleton loader block with a token-driven shimmer.
// Honors `prefers-reduced-motion` via the CSS keyframes media-query in
// globals.css — when reduced motion is on, the shimmer freezes to a static
// `--surface-raised` tint.

import { CSSProperties } from 'react'

export interface SkeletonProps {
  width?: number | string
  height?: number | string
  radius?: number | string
  className?: string
  style?: CSSProperties
}

export function Skeleton({
  width = '100%',
  height = 16,
  radius = 6,
  className,
  style,
}: SkeletonProps) {
  return (
    <div
      aria-hidden
      className={`clawboo-skeleton ${className ?? ''}`}
      style={{
        width: typeof width === 'number' ? `${width}px` : width,
        height: typeof height === 'number' ? `${height}px` : height,
        borderRadius: typeof radius === 'number' ? `${radius}px` : radius,
        ...style,
      }}
    />
  )
}
