'use client'

import { memo } from 'react'
import { BaseEdge, getSmoothStepPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useGraphStore } from '../store'

// ─── DependencyEdge — fast animated red dashes: Boo → Boo ────────────────────
// Stays smooth-step (stepped routing) — visual contrast with organic bezier
// curves on skill/resource edges is intentional information design.

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
      style={{
        stroke: selected ? '#E94560' : 'rgba(233,69,96,0.55)',
        strokeWidth: selected ? 2.5 : 1.5,
        strokeDasharray: '8 6',
        animation: 'marchingAnts 0.38s linear infinite',
        transition: 'stroke 0.15s, stroke-width 0.15s, opacity 0.2s ease',
        opacity: isHighlighted ? 1 : 0.12,
      }}
    />
  )
})
