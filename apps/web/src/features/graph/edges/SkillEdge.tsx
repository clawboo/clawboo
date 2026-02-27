'use client'

import { memo } from 'react'
import { BaseEdge, getSmoothStepPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'

// ─── SkillEdge — animated mint dashes: Boo → Skill ───────────────────────────

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
        stroke: selected ? '#34D399' : 'rgba(52,211,153,0.5)',
        strokeWidth: selected ? 2 : 1.5,
        strokeDasharray: '8 6',
        animation: 'marchingAnts 0.6s linear infinite',
        transition: 'stroke 0.15s, stroke-width 0.15s',
      }}
    />
  )
})
