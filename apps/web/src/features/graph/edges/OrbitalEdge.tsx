import { getBezierPath, useStore } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { motion, useReducedMotion } from 'framer-motion'
import { useGraphStore } from '../store'
import { orbitStaggerDelay } from '../usePeacockTransition'

// ─── OrbitalEdge — shared Boo → orbital-tile connector ───────────────────────
//
// One premium edge treatment for both skill (mint / accent) and resource
// (violet) connections:
//
//   • **Direction-following gradient**: a `userSpaceOnUse` linear gradient
//     pinned to the live source/target coordinates (the Dify technique), so
//     the stroke fades from near-transparent at the Boo to full accent at
//     the tile — the eye reads "this thing belongs to that agent" without
//     the line shouting across the canvas.
//
//   • **Draw-in / retract**: the path animates `pathLength` in sync with the
//     peacock expand — each edge GROWS out of the Boo alongside its tile
//     (delay matched to the tile's `orbitIndex` sweep position) and retracts
//     back into the Boo on collapse. Edges stay mounted while hidden
//     (pathLength 0, opacity 0) so the animation can play both ways.
//
//   • **Hover cascade**: brightens when connected to the hovered node, dims
//     otherwise — same store-driven highlight as before, with the app's
//     signature ease.
//
// When `data.isVisible` is undefined (MiniGraph), the edge renders fully
// visible with no draw animation — identical contract to the node peacock.

const EASE_SIGNATURE = [0.32, 0.72, 0, 1] as const

interface OrbitalEdgeProps {
  edge: EdgeProps
  /** Accent color (CSS color / var) — tile + edge read as one unit. */
  accent: string
  /**
   * Optional stroke GEOMETRY overrides, added for the grant edge.
   *
   * Geometry carries meaning that must survive zoom-out and reduced motion, so
   * it is deliberately a static property of the stroke rather than an animation:
   * dotted/solid/thick reads at any scale, a pulse does not.
   */
  dash?: string
  width?: number
  /** Marching dashes: reserved for "a human owes this edge a decision". */
  march?: boolean
}

export function OrbitalEdge({ edge, accent, dash, width, march }: OrbitalEdgeProps) {
  const {
    id,
    target,
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    selected,
    data,
  } = edge

  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    curvature: 0.2,
  })

  // Hover cascade — brighten when connected to hovered node, dim otherwise
  const isHighlighted = useGraphStore(
    (s) => s.hoveredNodeId === null || (s.highlightedEdgeIds?.has(id) ?? false),
  )

  // `undefined` (MiniGraph) → always visible, no draw animation.
  // Reduced motion also collapses `animates` to false, so the edge snaps to
  // its end state (drawn / gone) instead of sweeping — the same "keep the
  // result, drop the travel" rule the nodes and the physics loop follow.
  const isVisibleFlag = (data as { isVisible?: boolean } | undefined)?.isVisible
  const isVisible = isVisibleFlag !== false
  const reduceMotion = useReducedMotion()
  const animates = isVisibleFlag !== undefined && !reduceMotion

  // The target tile's sweep position — drives this edge's draw delay so the
  // edge grows in step with its tile's peacock arrival. Primitive-returning
  // selectors keep the subscription re-render-free.
  const orbitIndex = useStore(
    (s) =>
      (s.nodeLookup.get(target)?.internals.userNode.data as { orbitIndex?: number } | undefined)
        ?.orbitIndex ?? 0,
  )
  const orbitCount = useStore(
    (s) =>
      (s.nodeLookup.get(target)?.internals.userNode.data as { orbitCount?: number } | undefined)
        ?.orbitCount ?? 1,
  )

  const delay = animates ? orbitStaggerDelay(orbitIndex, orbitCount, isVisible) : 0
  const gradId = `orbital-edge-${id}`
  // A caller-supplied width is the edge's RESTING width, not a veto on selection.
  // Grant edges always pass one (privilege is encoded as thickness), so taking the
  // explicit value verbatim made them the only edges on the canvas that did not
  // respond to being selected at all.
  const baseWidth = width ?? 1.75
  const strokeWidth = selected ? baseWidth + 0.75 : baseWidth

  // Two separate opacity channels, deliberately kept apart:
  //   • VISIBILITY (0 ↔ 1) is animated by framer alongside pathLength and
  //     carries the peacock stagger `delay` — it only ever changes on
  //     expand / collapse, so the delay never replays at other times.
  //   • The HOVER CASCADE dim rides a plain CSS transition on the wrapping
  //     <g>. Folding it into the framer opacity (the first cut of this
  //     component) made every hover dim/brighten replay the stagger delay —
  //     the last edges of a big fan lagged the cascade by ~0.3s.
  const cascadeOpacity = isHighlighted ? 1 : 0.12

  // Collapsed-edge render diet: while hidden, only the single retracting
  // main path stays mounted (it must, to animate the fold-in and the next
  // draw-out). The gradient defs, glow twin, and interaction hit-area
  // mount only while visible — collapsed fans following a dragged Boo
  // re-render every physics frame, and 4 SVG elements × every collapsed
  // edge is real DOM churn for zero pixels.
  return (
    <g
      style={{
        opacity: cascadeOpacity,
        transition: 'opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
      }}
    >
      {isVisible && (
        <defs>
          {/* Gradient pinned to user space so it follows the edge direction:
              quiet at the Boo end, full accent at the tile end. */}
          <linearGradient
            id={gradId}
            gradientUnits="userSpaceOnUse"
            x1={sourceX}
            y1={sourceY}
            x2={targetX}
            y2={targetY}
          >
            <stop offset="0%" style={{ stopColor: accent, stopOpacity: 0.3 }} />
            <stop offset="100%" style={{ stopColor: accent, stopOpacity: 0.95 }} />
          </linearGradient>
        </defs>
      )}

      {/* Soft under-glow — a wider low-opacity twin beneath the main stroke;
          the cascade <g> above brightens/dims it together with the edge.
          Mounts at expand start with pathLength 0 so it draws in with the
          fan (unmounts on collapse — the 8%-opacity glow needs no retract). */}
      {isVisible && (
        <motion.path
          d={edgePath}
          fill="none"
          stroke={accent}
          strokeWidth={6}
          strokeLinecap="round"
          initial={animates ? { pathLength: 0, opacity: 0 } : false}
          animate={{
            pathLength: 1,
            opacity: selected ? 0.18 : 0.08,
          }}
          transition={
            animates
              ? {
                  pathLength: { duration: 0.38, ease: EASE_SIGNATURE, delay },
                  opacity: { duration: 0.2, delay },
                }
              : { duration: 0 }
          }
        />
      )}

      {/* Main stroke — gradient, grows out of the Boo / retracts back in.
          Always mounted so both directions of the pathLength animation play.
          While collapsed the gradient defs are unmounted, so fall back to
          the solid accent (only visible for the 0.2s retract — the
          difference is imperceptible at that scale). */}
      <motion.path
        d={edgePath}
        fill="none"
        stroke={selected || !isVisible ? accent : `url(#${gradId})`}
        strokeWidth={strokeWidth}
        strokeLinecap="round"
        strokeDasharray={dash}
        initial={false}
        animate={{
          pathLength: isVisible ? 1 : 0,
          opacity: isVisible ? 1 : 0,
          // The march runs only when there is something to decide, and only when
          // motion is allowed. Under reduced motion the dash pattern alone still
          // distinguishes the state.
          ...(march && dash && !reduceMotion ? { strokeDashoffset: [0, -16] } : {}),
        }}
        transition={
          animates
            ? {
                pathLength: isVisible
                  ? { duration: 0.38, ease: EASE_SIGNATURE, delay }
                  : { duration: 0.22, ease: 'easeIn', delay },
                opacity: isVisible
                  ? { duration: 0.2, delay }
                  : { duration: 0.16, delay: delay + 0.04 },
                ...(march && dash && !reduceMotion
                  ? { strokeDashoffset: { duration: 1.1, ease: 'linear', repeat: Infinity } }
                  : {}),
              }
            : march && dash && !reduceMotion
              ? {
                  strokeDashoffset: { duration: 1.1, ease: 'linear', repeat: Infinity },
                }
              : { duration: 0 }
        }
      />

      {/* Invisible interaction hit-area so the edge stays clickable
          (explain-panel) — mounted only while visible. */}
      {isVisible && (
        <path
          d={edgePath}
          fill="none"
          strokeOpacity={0}
          strokeWidth={16}
          className="react-flow__edge-interaction"
          style={{ pointerEvents: 'stroke' }}
        />
      )}
    </g>
  )
}
