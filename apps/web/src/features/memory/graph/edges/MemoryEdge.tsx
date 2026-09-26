import { memo } from 'react'
import { BaseEdge, getBezierPath } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useMemoryGraphStore } from '../store'
import type { MemEdgeData } from '../types'

// ─── MemoryEdge — one component, `data.kind` switches the style ──────────────
//
//   similarity: solid, width/opacity scale with cosine weight
//   tag:        dashed (a shared-vocabulary link, weaker than similarity)
//   version:    dotted (procedure lineage)
//
// ACHROMATIC, like the nodes: kind reads from the dash pattern and strength
// from opacity. Edges are structure, not subject: they should sit under the
// labels, never compete with them. A cross-cluster link recedes further still,
// so cluster shape is legible from the linework alone.

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
  const sameCluster = d?.sameCluster ?? false

  // Endpoint-active: raised opacity when either end is hovered/selected.
  const active = useMemoryGraphStore(
    (s) =>
      (s.hoveredNodeId != null && (s.hoveredNodeId === source || s.hoveredNodeId === target)) ||
      (s.selectedNodeId != null && (s.selectedNodeId === source || s.selectedNodeId === target)),
  )

  let strokeWidth: number
  let opacity: number
  let dash: string | undefined
  if (kind === 'similarity') {
    const w = clamp01((weight - 0.6) / 0.4)
    strokeWidth = 1 + 0.5 * w
    opacity = 0.62 + 0.38 * w
    dash = undefined
  } else if (kind === 'tag') {
    strokeWidth = 1
    opacity = 0.5 + 0.3 * clamp01(weight)
    dash = '3 4'
  } else {
    strokeWidth = 1
    opacity = 0.6
    dash = '1.5 3'
  }
  if (!sameCluster) opacity *= 0.7
  if (active) opacity = 1

  return (
    <BaseEdge
      id={id}
      path={edgePath}
      style={{
        stroke: 'var(--graph-edge)',
        strokeWidth,
        strokeLinecap: 'round',
        strokeDasharray: dash,
        opacity,
        transition: 'opacity 150ms ease',
      }}
    />
  )
})
