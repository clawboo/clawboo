import { memo } from 'react'
import { BaseEdge, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useGraphStore } from '../store'

// ─── SkillEdge — solid static mint bezier: Boo → Skill ───────────────────────
//
// Skill ownership is NOT directional — a Boo "has" a skill, and the
// relationship is symmetric. The previous implementation used a marching-ants
// animation (animated `stroke-dashoffset`) which implied flow direction; user
// feedback was that this was misleading. We now render a calm solid stroke
// that reads as "this is a relationship, not a process."

export const SkillEdge = memo(function SkillEdge({
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
        stroke: selected ? '#34D399' : 'rgba(52,211,153,0.4)',
        strokeWidth: selected ? 2 : 1.5,
        // No strokeDasharray, no animation — solid static line.
        transition: 'stroke 0.15s, stroke-width 0.15s, opacity 0.2s ease',
        opacity: isHighlighted ? 1 : 0.12,
      }}
    />
  )
})
