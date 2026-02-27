'use client'

import { memo } from 'react'
import { BaseEdge, getSmoothStepPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'

// ─── ResourceEdge — slow animated amber dashes: Boo → Resource ───────────────

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
        stroke: selected ? '#FBBF24' : 'rgba(251,191,36,0.5)',
        strokeWidth: selected ? 2 : 1,
        strokeDasharray: '8 6',
        animation: 'marchingAnts 0.9s linear infinite',
        transition: 'stroke 0.15s, stroke-width 0.15s',
      }}
    />
  )
})
