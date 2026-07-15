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
  data,
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

  // The edge inherits its TILE's type accent (threaded via `data.accent` by
  // `buildGraphElements` — amber for Leadership, provider brand for the Model,
  // slate for the built-ins rollup) so an edge + its tile read as one unit.
  // No accent → mint, the skill/tool type accent.
  const accent = (data as { accent?: string } | undefined)?.accent ?? 'var(--mint)'

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: selected ? accent : `color-mix(in srgb, ${accent} 55%, transparent)`,
        strokeWidth: selected ? 2.5 : 1.75,
        // No strokeDasharray, no animation — solid static line.
        transition: 'stroke 0.15s, stroke-width 0.15s, opacity 0.2s ease',
        opacity: isHighlighted ? 1 : 0.12,
      }}
    />
  )
})
