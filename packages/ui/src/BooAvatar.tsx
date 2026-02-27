import { memo } from 'react'
import { generateBooAvatar } from '@clawboo/boo-avatar'
import type { BooAvatarParams } from '@clawboo/boo-avatar'

// ─── BooAvatar props ──────────────────────────────────────────────────────────

export interface BooAvatarProps extends BooAvatarParams {
  /**
   * Width in pixels. Height is auto-computed from the SVG aspect ratio (100:92).
   * @default 40
   */
  size?: number
  className?: string
}

// The SVG viewBox is 0 0 100 92 — height = size × (92/100)
const ASPECT = 92 / 100

// ─── BooAvatar ────────────────────────────────────────────────────────────────
// Renders the Boo avatar as an inline SVG.
// Memoized: re-renders only when seed/size/accessory/eyeShape/tint change.

export const BooAvatar = memo(function BooAvatar({
  size = 40,
  className,
  ...params
}: BooAvatarProps) {
  const w = size
  const h = Math.round(size * ASPECT)

  // generateBooAvatar outputs fixed width="100" height="92" — replace with
  // the requested dimensions so the SVG scales correctly in any container.
  const svg = generateBooAvatar(params).replace(
    'width="100" height="92"',
    `width="${w}" height="${h}"`,
  )

  return (
    <span
      className={className}
      style={{ display: 'inline-flex', width: w, height: h, flexShrink: 0 }}
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  )
})
