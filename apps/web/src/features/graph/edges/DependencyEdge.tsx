import { memo } from 'react'
import { BaseEdge, getSmoothStepPath } from '@xyflow/react'
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

export const DependencyEdge = memo(function DependencyEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps) {
  const [edgePath] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: 10,
  })

  // Hover cascade — brighten when connected to hovered node, dim otherwise
  const isHighlighted = useGraphStore(
    (s) => s.hoveredNodeId === null || (s.highlightedEdgeIds?.has(id) ?? false),
  )

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      markerEnd="url(#dependency-arrow)"
      style={{
        stroke: selected ? '#E94560' : 'rgba(233,69,96,0.65)',
        strokeWidth: selected ? 2.5 : 1.5,
        // No strokeDasharray, no animation — bezier + arrowhead carries
        // direction more clearly than marching-ants did.
        transition: 'stroke 0.15s, stroke-width 0.15s, opacity 0.2s ease',
        // Slightly less aggressive dim than skill/resource edges (0.12)
        // so the team-topology backbone stays readable when a Boo is hovered.
        opacity: isHighlighted ? 1 : 0.18,
      }}
    />
  )
})
