import { memo } from 'react'
import { BaseEdge, getBezierPath, getSmoothStepPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useGraphStore } from '../store'

// ─── DependencyEdge — Boo → Boo flow-chart connector ─────────────────────────
//
// Smooth-step (orthogonal) path with a small accent-red arrowhead at the
// target end. The arrowhead conveys direction (leader → teammate routing)
// at a glance, which is what gives the canvas its flow-chart feel under
// the layered ELK layout. The marching-ants animation that used to live
// here is dropped — the arrowhead is a clearer direction cue than animated
// dashes, and removing the constant motion makes the canvas calmer.
//
// `markerEnd` references `url(#dependency-arrow)` defined once in
// `<EdgeMarkers />` (mounted near the top of `GhostGraph`).
//
// **Primary vs secondary edges** (Paperclip-style org-chart filter):
//   - Primary edges (BFS spanning tree from team leader) are always
//     visible; they form the readable hierarchy backbone.
//   - Secondary edges (every other routing rule) are HIDDEN at rest and
//     fade in only when their source or target Boo is hovered. This keeps
//     the canvas as readable as a real org chart while still letting the
//     user discover lateral collaboration paths on demand.
//   - The `isPrimary` flag is set in `useGraphData.buildGraphElements`
//     via `computeSpanningTree`. ELK only sees primary edges (filtered
//     in `GhostGraph.tsx`) so the layout itself isn't tangled by
//     secondary routes.

interface DependencyEdgeData extends Record<string, unknown> {
  isPrimary?: boolean
}

export const DependencyEdge = memo(function DependencyEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps) {
  const isPrimary = (data as DependencyEdgeData | undefined)?.isPrimary !== false

  // Primary edges (BFS spanning tree) use orthogonal smooth-step — the
  // standard org-chart shape. Secondary collaboration edges use bezier
  // curves so they (a) are visually distinct from the structural backbone,
  // and (b) naturally fan AWAY from the leader-to-children row instead of
  // stacking on top of each other (which produced the "messy bundle" effect
  // when many secondary edges were revealed by hovering a teammate Boo in
  // a wide row of siblings).
  const [edgePath] = isPrimary
    ? getSmoothStepPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
        borderRadius: 10,
      })
    : getBezierPath({
        sourceX,
        sourceY,
        targetX,
        targetY,
        sourcePosition,
        targetPosition,
        // Bumped curvature pulls secondary edges further off the primary
        // hierarchy line, making them read as "lateral" rather than
        // "structural".
        curvature: 0.45,
      })

  // Hover-aware visibility:
  //   - Primary: full opacity at rest; dimmed when ANOTHER node is hovered.
  //   - Secondary: invisible at rest; only fades in when the hovered node is
  //     this edge's source or target.
  // We read `hoveredNodeId` directly so each edge can compute its own
  // visibility without bloating `highlightedEdgeIds` with hide/reveal logic.
  const hoveredNodeId = useGraphStore((s) => s.hoveredNodeId)
  const isConnectedToHovered =
    hoveredNodeId !== null && (hoveredNodeId === source || hoveredNodeId === target)

  let opacity: number
  if (isPrimary) {
    // Primary backbone: full opacity at rest, slight dim when the hover
    // cluster doesn't include this edge.
    opacity = hoveredNodeId === null || isConnectedToHovered ? 1 : 0.18
  } else {
    // Secondary collaboration edge: hidden at rest, fade in subtly on hover.
    // Lower opacity (0.4 vs primary's 1.0) makes the hierarchy stay readable
    // even with many secondary edges revealed simultaneously.
    opacity = isConnectedToHovered ? 0.4 : 0
  }

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd={opacity > 0 ? 'url(#dependency-arrow)' : undefined}
      style={{
        stroke: selected ? '#E94560' : 'rgba(233,69,96,0.65)',
        strokeWidth: selected ? 2.5 : 1.5,
        // Secondary edges use a thin dash so they're visually distinct from
        // primary ones when revealed on hover (a "this is a collaboration
        // path, not a primary report" cue).
        strokeDasharray: isPrimary ? undefined : '4 4',
        transition: 'stroke 0.15s, stroke-width 0.15s, opacity 0.2s ease',
        opacity,
        // Make secondary edges click-through when hidden so they don't
        // intercept events meant for nodes behind them.
        pointerEvents: opacity > 0 ? 'auto' : 'none',
      }}
    />
  )
})
