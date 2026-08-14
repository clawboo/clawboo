// Peacock-feather expand / collapse for orbital children (skill + resource
// nodes) in the Ghost Graph.
//
// When a Boo is single-clicked, its orbital children's `data.isVisible`
// flips. This hook returns Framer-Motion props that animate each child
// FROM the parent Boo's center TO its orbital position (and back into the
// Boo on collapse) — a true "burst out of the agent" motion, not just a
// scale-in-place. The translate delta is computed against the parent's
// LIVE position (via React Flow's internal node lookup), so the burst
// originates from wherever the Boo actually is — even mid-drag or while
// physics is settling.
//
// Stagger: children sweep out in ARC ORDER (`data.orbitIndex`, stamped by
// `computeOrbitalPositions` — inner skill ring first, then the resource
// ring), producing a directed fan sweep instead of the old random
// hash-bucket order. Collapse runs a fast reverse sweep so the fan folds
// back into the Boo.
//
// MiniGraph and any consumer that doesn't set `data.isVisible` gets the
// "always visible" treatment automatically (undefined → static, no motion).

import { useMemo } from 'react'
import { useInternalNode } from '@xyflow/react'
import { useReducedMotion } from 'framer-motion'
import type { Transition } from 'framer-motion'

// Matches BOO_FOOTPRINT in `nodes/BooNode.tsx` — fallback when the parent's
// measured size isn't available yet.
const BOO_FOOTPRINT = 280

// Expand sweep: total budget for the fan, clamped per-step so tiny fans
// still stagger visibly and huge fans don't take forever.
const EXPAND_SWEEP_TOTAL_S = 0.36
const EXPAND_STEP_MIN_S = 0.028
const EXPAND_STEP_MAX_S = 0.06
// Collapse: quick reverse sweep — the fan folds back into the Boo.
const COLLAPSE_STEP_S = 0.014

/** Per-child delay within the peacock sweep. Shared with the orbital edges
 *  so an edge draws in sync with its node's arrival. */
export function orbitStaggerDelay(
  orbitIndex: number | undefined,
  orbitCount: number | undefined,
  expanding: boolean,
): number {
  const count = Math.max(orbitCount ?? 1, 1)
  const index = Math.min(Math.max(orbitIndex ?? 0, 0), count - 1)
  if (expanding) {
    const step = Math.min(
      EXPAND_STEP_MAX_S,
      Math.max(EXPAND_STEP_MIN_S, EXPAND_SWEEP_TOTAL_S / Math.max(count - 1, 1)),
    )
    return index * step
  }
  return (count - 1 - index) * COLLAPSE_STEP_S
}

interface PeacockMotionProps {
  /** Pass to the wrapping `motion.div`. `initial: false` = no mount replay —
   *  a node mounting collapsed simply *is* at the parent, invisible. */
  initial: false
  animate: { x: number; y: number; opacity: number; scale: number }
  transition: Transition
  /**
   * `pointer-events` toggle so collapsed nodes don't intercept clicks
   * meant for the Boo behind them. Apply to the same wrapper.
   */
  pointerEvents: 'auto' | 'none'
}

export interface PeacockArgs {
  nodeId: string
  isVisible: boolean | undefined
  /** Owning agent id (`data.agentIds[0]`) — resolves the parent Boo node. */
  parentAgentId: string | null | undefined
  /** This node's absolute flow position (NodeProps.positionAbsoluteX/Y). */
  positionAbsoluteX: number
  positionAbsoluteY: number
  /** Visual disc size — the translate delta targets the disc center. */
  selfSize: number
  orbitIndex?: number
  orbitCount?: number
}

export function usePeacockTransition({
  isVisible,
  parentAgentId,
  positionAbsoluteX,
  positionAbsoluteY,
  selfSize,
  orbitIndex,
  orbitCount,
}: PeacockArgs): PeacockMotionProps {
  // Subscribe to the parent Boo's live position so the burst origin tracks
  // it through drags and physics settles. Hook is called unconditionally
  // (dummy id when there's no parent / no visibility tracking).
  const parentNode = useInternalNode(
    isVisible !== undefined && parentAgentId ? `boo-${parentAgentId}` : '__peacock_none__',
  )

  // Reduced motion: keep the END STATE (position, opacity, scale) exactly as
  // it would be, but drop the travel — the fan appears/disappears instantly
  // instead of sweeping out of the Boo. Same principle the graph's RAF loops
  // follow (`@/lib/prefersReducedMotion`): the graph stays correct, only the
  // animation goes. Framer's hook is the component-side half of that contract.
  const reduceMotion = useReducedMotion()

  const parentX = parentNode
    ? parentNode.internals.positionAbsolute.x + (parentNode.measured?.width ?? BOO_FOOTPRINT) / 2
    : null
  const parentY = parentNode
    ? parentNode.internals.positionAbsolute.y + (parentNode.measured?.height ?? BOO_FOOTPRINT) / 2
    : null

  return useMemo(() => {
    // MiniGraph / any consumer that doesn't track visibility: render plainly,
    // no animation.
    if (isVisible === undefined) {
      return {
        initial: false as const,
        animate: { x: 0, y: 0, opacity: 1, scale: 1 },
        transition: { duration: 0 },
        pointerEvents: 'auto' as const,
      }
    }

    // Offset from this node's orbital spot to the parent Boo's center — the
    // collapsed resting point. Falls back to "in place" if the parent isn't
    // resolvable (shouldn't happen for real orbitals).
    const deltaX = parentX !== null ? parentX - (positionAbsoluteX + selfSize / 2) : 0
    const deltaY = parentY !== null ? parentY - (positionAbsoluteY + selfSize / 2) : 0

    const delay = reduceMotion ? 0 : orbitStaggerDelay(orbitIndex, orbitCount, isVisible)

    if (reduceMotion) {
      return {
        initial: false as const,
        animate: isVisible
          ? { x: 0, y: 0, opacity: 1, scale: 1 }
          : { x: deltaX, y: deltaY, opacity: 0, scale: 0.25 },
        transition: { duration: 0 },
        pointerEvents: (isVisible ? 'auto' : 'none') as 'auto' | 'none',
      }
    }

    if (isVisible) {
      return {
        initial: false as const,
        animate: { x: 0, y: 0, opacity: 1, scale: 1 },
        transition: {
          type: 'spring',
          stiffness: 340,
          damping: 27,
          mass: 0.9,
          delay,
          opacity: { duration: 0.18, delay },
        } satisfies Transition,
        pointerEvents: 'auto' as const,
      }
    }

    return {
      initial: false as const,
      animate: { x: deltaX, y: deltaY, opacity: 0, scale: 0.25 },
      transition: {
        type: 'spring',
        stiffness: 420,
        damping: 36,
        mass: 0.8,
        delay,
        opacity: { duration: 0.14, delay: delay + 0.05 },
      } satisfies Transition,
      pointerEvents: 'none' as const,
    }
  }, [
    isVisible,
    parentX,
    parentY,
    positionAbsoluteX,
    positionAbsoluteY,
    selfSize,
    orbitIndex,
    orbitCount,
    reduceMotion,
  ])
}
