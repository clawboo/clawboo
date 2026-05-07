// Peacock-feather expand / collapse animation for orbital children
// (skill + resource nodes) in the Ghost Graph.
//
// When a Boo is single-clicked, its orbital children's `data.isVisible`
// flips between true and false. This hook returns Framer-Motion props
// that animate each child node from "behind the Boo" (scale 0, offset
// toward parent center) to its orbital position — and back when collapsed.
//
// The animation is staggered per-node via a deterministic hash of the
// node ID so the children appear in a fan-like sweep rather than all at
// once. Hash-based stagger keeps the visual feel without requiring an
// external "index" passed through node data.
//
// MiniGraph and any consumer that doesn't set `data.isVisible` gets the
// "always visible" treatment automatically (treated as undefined → true).

import { useMemo } from 'react'
import type { Transition } from 'framer-motion'

// FNV-1a-ish 32-bit hash for the stagger delay. Same approach used elsewhere
// in `useFloatingMotion` for deterministic per-node motion params.
function hashString(s: string): number {
  let h = 0x811c9dc5
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i)
    h = Math.imul(h, 0x01000193)
  }
  return h >>> 0
}

const STAGGER_BUCKETS = 8 // number of stagger groups (0 .. 7 × 50ms)
const STAGGER_STEP_MS = 50

interface PeacockMotionProps {
  /** Pass to the wrapping `motion.div`. */
  initial: { opacity: number; scale: number }
  animate: { opacity: number; scale: number }
  transition: Transition
  /**
   * `pointer-events` toggle so collapsed nodes don't intercept clicks
   * meant for the Boo behind them. Apply to the same wrapper.
   */
  pointerEvents: 'auto' | 'none'
}

/**
 * Returns Framer-Motion `initial` / `animate` / `transition` for a peacock
 * expand-collapse on `isVisible` flip. When `isVisible` is `undefined`
 * (e.g. MiniGraph), behaves as "always visible" with no transition.
 */
export function usePeacockTransition(
  nodeId: string,
  isVisible: boolean | undefined,
): PeacockMotionProps {
  return useMemo(() => {
    // MiniGraph / any consumer that doesn't track visibility: render plainly,
    // no animation.
    if (isVisible === undefined) {
      return {
        initial: { opacity: 1, scale: 1 },
        animate: { opacity: 1, scale: 1 },
        transition: { duration: 0 },
        pointerEvents: 'auto',
      }
    }

    const stagger = (hashString(nodeId) % STAGGER_BUCKETS) * STAGGER_STEP_MS

    return {
      // We render once at the orbital target (set by computeOrbitalPositions),
      // and Framer Motion animates the visual "appear from behind the Boo"
      // by tweening scale + opacity. We deliberately don't translate (x/y) —
      // the spring on `scale` pinned at the node's center already produces
      // the "bursting from the parent" feel without us computing per-node
      // offsets toward the parent Boo. This keeps the animation stable when
      // the parent Boo is being dragged during the transition.
      initial: { opacity: 0, scale: 0 },
      animate: {
        opacity: isVisible ? 1 : 0,
        scale: isVisible ? 1 : 0,
      },
      transition: {
        type: 'spring',
        stiffness: 240,
        damping: 22,
        // Stagger only on expand (when visible); collapse should be quick
        // and synchronous so the visual clutter clears immediately.
        delay: isVisible ? stagger / 1000 : 0,
        opacity: isVisible ? { duration: 0.18, delay: stagger / 1000 } : { duration: 0.12 },
      },
      pointerEvents: isVisible ? 'auto' : 'none',
    }
  }, [nodeId, isVisible])
}
