import { memo } from 'react'
import { BaseEdge, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useMemoryGraphStore } from '../store'
import type { MemEdgeData } from '../types'

// ─── MemoryEdge — one component, `data.kind` switches the style ──────────────
//
//   similarity — solid bezier, width/opacity scale with cosine weight
//   tag        — dashed 4 4 (a shared-vocabulary link, weaker than similarity)
//   version    — dotted (procedure lineage decoration)
//
// Endpoint hover/selection raises opacity so the inspect loop reads.

const clamp01 = (x: number): number => Math.min(1, Math.max(0, x))

export const MemoryEdge = memo(function MemoryEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
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
  const d = data as MemEdgeData | undefined
  const kind = d?.kind ?? 'tag'
  const weight = d?.weight ?? 0

  // Endpoint-active: raised opacity when either end is hovered/selected.
  const active = useMemoryGraphStore(
    (s) =>
      (s.hoveredNodeId != null && (s.hoveredNodeId === source || s.hoveredNodeId === target)) ||
      (s.selectedNodeId != null && (s.selectedNodeId === source || s.selectedNodeId === target)),
  )

  // Shared-community edges tint toward the community color; cross-community
  // links stay neutral foreground.
  const stroke = d?.communityColor
    ? `color-mix(in srgb, ${d.communityColor} 55%, transparent)`
    : 'rgb(var(--foreground-rgb) / 0.4)'

  let strokeWidth: number
  let opacity: number
  let dash: string | undefined
  if (kind === 'similarity') {
    const w = clamp01((weight - 0.6) / 0.4)
    strokeWidth = 1 + 1.5 * w
    opacity = 0.25 + 0.5 * w
    dash = undefined
  } else if (kind === 'tag') {
    strokeWidth = 1
    opacity = 0.18 + 0.3 * clamp01(weight)
    dash = '4 4'
  } else {
    strokeWidth = 1
    opacity = 0.3
    dash = '2 3'
  }
  if (active) opacity = Math.max(opacity, 0.9)

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: kind === 'version' ? 'rgb(var(--foreground-rgb) / 0.35)' : stroke,
        strokeWidth,
        strokeDasharray: dash,
        opacity,
        transition: 'opacity 150ms ease',
      }}
    />
  )
})
