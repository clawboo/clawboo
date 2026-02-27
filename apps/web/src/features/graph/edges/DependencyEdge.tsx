'use client'

import { memo } from 'react'
import { BaseEdge, getSmoothStepPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'

// ─── DependencyEdge — fast animated red dashes: Boo → Boo ────────────────────

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

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: selected ? '#E94560' : 'rgba(233,69,96,0.65)',
        strokeWidth: selected ? 2.5 : 1.5,
        strokeDasharray: '8 6',
        animation: 'marchingAnts 0.38s linear infinite',
        transition: 'stroke 0.15s, stroke-width 0.15s',
      }}
    />
  )
})
