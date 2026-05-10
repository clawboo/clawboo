import { useLayoutEffect, useRef, type MutableRefObject, type RefCallback } from 'react'

// ─── FLIP-style slide animation for sub-elements during shape morph ──────────
//
// "FLIP" = First, Last, Invert, Play. We capture each tracked element's
// bounding rect at unmount-time of one layout (CardContent / CircleContent),
// and on the next mount of the OTHER layout we measure the new rect, compute
// the inverse transform back to the captured position, then animate to
// identity. Result: the element appears to slide from its previous layout
// position to its new one across the unmount/remount boundary.
//
// Why this and not Framer Motion's `layout` / `layoutId`? Because BooNode is
// mounted in BOTH `GhostGraphPanel` and `MiniGraph` (via shared `nodeTypes`).
// FM's layout system tracks `layoutId`s globally — identical ids in two trees
// during a `<AnimatePresence mode="wait">` route transition jam the exit
// cycle, leaving the previous view stuck and chat panels unable to mount.
// FLIP done manually has NO global registry: each `FlipState` is owned by a
// specific `BooNode` instance via `useRef`. Cross-component coordination is
// impossible by construction.
//
// `state` is owned by the parent BooNode (not by the hook) so it persists
// across the CardContent ↔ CircleContent unmount/remount that happens on
// every shape morph. Two timing wrinkles handled below:
//
//   1. **StrictMode double-invocation**: in dev, useLayoutEffect fires twice
//      on every mount (mount → cleanup → mount). The first run applies the
//      inverse transform; if the second run measured rects again it would
//      see the post-transform "old" position and trigger a REVERSE FLIP.
//      The `el.style.transform` guard skips the second run cleanly.
//
//   2. **Physics-moved positions stay fresh**: `useFloatingMotion` writes a
//      transient transform to the parent floatRef wrapper, drifting the
//      visible avatar by a few pixels on every frame. If we captured the
//      rect only on initial mount, the stored rect would be stale by the
//      time the layout actually morphed. Capturing in the cleanup
//      (immediately before unmount) ensures the rect reflects whatever the
//      most recent paint looked like, so the FLIP animation starts from
//      the position the user actually saw.

export interface FlipState {
  rect: DOMRect | null
}

export function createFlipState(): FlipState {
  return { rect: null }
}

const TRANSITION = 'transform 0.3s cubic-bezier(0.4, 0, 0.2, 1)'

const POSITION_DELTA_THRESHOLD = 1 // pixels
const SCALE_DELTA_THRESHOLD = 0.02 // 2% size change

export function useFlipMorph<T extends HTMLElement = HTMLElement>(
  state: MutableRefObject<FlipState>,
): RefCallback<T> {
  const elRef = useRef<T | null>(null)

  useLayoutEffect(() => {
    const el = elRef.current
    if (!el) return

    // StrictMode guard — see header note.
    if (el.style.transform && el.style.transform !== 'none') {
      return
    }

    const newRect = el.getBoundingClientRect()
    const oldRect = state.current.rect

    if (oldRect && oldRect.width > 0 && newRect.width > 0) {
      const dx = oldRect.left - newRect.left
      const dy = oldRect.top - newRect.top
      const sx = oldRect.width / newRect.width
      const sy = oldRect.height / newRect.height

      const moved =
        Math.abs(dx) > POSITION_DELTA_THRESHOLD || Math.abs(dy) > POSITION_DELTA_THRESHOLD
      const resized =
        Math.abs(sx - 1) > SCALE_DELTA_THRESHOLD || Math.abs(sy - 1) > SCALE_DELTA_THRESHOLD

      if (moved || resized) {
        // Step 1: jump to the OLD position via inverse transform (no transition)
        el.style.transition = 'none'
        el.style.transformOrigin = '0 0'
        el.style.transform = `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})`
        // Step 2: force a reflow so the browser commits the inverse transform
        void el.offsetWidth
        // Step 3: animate to identity on the next frame
        requestAnimationFrame(() => {
          const animEl = elRef.current
          if (!animEl) return
          animEl.style.transition = TRANSITION
          animEl.style.transform = ''
        })
      }
    }

    state.current.rect = newRect

    // Cleanup runs at unmount. Capture the most recent rect so the NEXT
    // mount (the OTHER layout) has a fresh starting point — even if physics
    // / float-motion drifted the position since this mount's initial capture.
    // Skip if a FLIP transform is still applied (mid-animation): in that
    // case the previously stored rect is the correct stable layout rect.
    return () => {
      const cleanupEl = elRef.current
      if (!cleanupEl) return
      if (cleanupEl.style.transform && cleanupEl.style.transform !== 'none') return
      state.current.rect = cleanupEl.getBoundingClientRect()
    }
  }, [])

  return (el: T | null) => {
    elRef.current = el
  }
}
