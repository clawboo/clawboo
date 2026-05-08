import { memo } from 'react'
import { BaseEdge, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useGraphStore } from '../store'

// ─── ResourceEdge — solid static amber bezier: Boo → Resource ────────────────
//
// Like the skill edge, resource ownership is not a directional process — a
// Boo "uses" a resource, the relationship is symmetric. Replaced the slow
// marching-ants animation with a calm static stroke for the same reasons
// (see SkillEdge.tsx for rationale).

export const ResourceEdge = memo(function ResourceEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
}: EdgeProps) {
  const [edgePath] = getBezierPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  })

  // Hover cascade — brighten when connected to hovered node, dim otherwise
  const isHighlighted = useGraphStore(
    (s) => s.hoveredNodeId === null || (s.highlightedEdgeIds?.has(id) ?? false),
  )

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: selected ? '#FBBF24' : 'rgba(251,191,36,0.35)',
        strokeWidth: selected ? 2 : 1,
        // No strokeDasharray, no animation — solid static line.
        transition: 'stroke 0.15s, stroke-width 0.15s, opacity 0.2s ease',
        opacity: isHighlighted ? 1 : 0.12,
      }}
    />
  )
})
