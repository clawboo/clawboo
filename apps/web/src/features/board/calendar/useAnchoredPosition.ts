// Fixed-position placement for a popover rendered in a portal and anchored to an
// element: below the anchor when it fits, above it when it does not, kept inside
// the viewport, and re-placed when anything scrolls or the window resizes. The
// board scrolls on two axes inside its own container, which is why the popovers
// live in a portal instead of in the grid.

import { useCallback, useEffect, useLayoutEffect, useState, type RefObject } from 'react'

export interface AnchoredPosition {
  left: number
  top?: number
  bottom?: number
  maxHeight: number
}

const GAP = 6
const EDGE = 8

export function useAnchoredPosition(
  anchor: RefObject<HTMLElement | null> | HTMLElement | null,
  open: boolean,
  width: number,
  desiredHeight: number,
): AnchoredPosition | null {
  const [pos, setPos] = useState<AnchoredPosition | null>(null)

  const compute = useCallback(() => {
    const el = anchor && 'current' in anchor ? anchor.current : anchor
    // A detached anchor measures as all zeros, which would fling the popover to
    // the corner; keep it where it was until its host closes it.
    if (!el || !el.isConnected) return
    const r = el.getBoundingClientRect()
    const below = window.innerHeight - r.bottom
    const above = r.top
    const up = below < desiredHeight + GAP + EDGE && above > below
    const maxHeight = Math.max(160, Math.min(desiredHeight, (up ? above : below) - GAP - EDGE))
    const left = Math.min(Math.max(EDGE, r.left), Math.max(EDGE, window.innerWidth - width - EDGE))
    setPos({
      left,
      maxHeight,
      ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
    })
  }, [anchor, width, desiredHeight])

  useLayoutEffect(() => {
    if (open) compute()
    else setPos(null)
  }, [open, compute])

  useEffect(() => {
    if (!open) return
    const reflow = () => compute()
    window.addEventListener('resize', reflow)
    window.addEventListener('scroll', reflow, true)
    return () => {
      window.removeEventListener('resize', reflow)
      window.removeEventListener('scroll', reflow, true)
    }
  }, [open, compute])

  return pos
}
