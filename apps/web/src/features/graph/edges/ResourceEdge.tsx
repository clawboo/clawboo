import { memo } from 'react'
import { BaseEdge, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useGraphStore } from '../store'

// ─── ResourceEdge — solid static VIOLET bezier: Boo → MCP connector ──────────
//
// Violet is the connector TYPE accent (matches the ResourceNode tile), so the
// edge + tile read as one unit at a glance. Like the skill edge, connector
// attachment is not a directional process — the relationship is symmetric, so
// a calm static stroke (no marching-ants animation).

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
        stroke: selected ? 'var(--violet)' : 'rgb(var(--violet-rgb) / 0.55)',
        strokeWidth: selected ? 2.5 : 1.75,
        // No strokeDasharray, no animation — solid static line.
        transition: 'stroke 0.15s, stroke-width 0.15s, opacity 0.2s ease',
        opacity: isHighlighted ? 1 : 0.12,
      }}
    />
  )
})
