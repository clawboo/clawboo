// React Flow element shapes for the Memory graph. Domain data (the payload
// node) rides inside `data` so node components read one object; sizes are
// precomputed at build time because ELK needs them before RF measures.

import type { Edge, Node } from '@xyflow/react'
import type { MemoryGraphEdgeKind, MemoryGraphNode } from '@/lib/memoryClient'

export interface MemFactData extends Record<string, unknown> {
  node: MemoryGraphNode
  /** Degree-scaled disc diameter: 34 + 26·√(degree/maxDegree). */
  diameter: number
  /** 75th-percentile degree — the label-declutter threshold. */
  degreeP75: number
}

export interface MemProcData extends Record<string, unknown> {
  node: MemoryGraphNode
}

export interface MemEdgeData extends Record<string, unknown> {
  kind: MemoryGraphEdgeKind
  weight: number
  sharedTags: string[]
  /** Both endpoints sit in the same cluster, so an intra-cluster link reads a
   *  touch stronger than one that crosses between clusters. */
  sameCluster: boolean
}

export type MemNodeData = MemFactData | MemProcData
export type MemFlowNode = Node<MemNodeData>
export type MemFlowEdge = Edge<MemEdgeData>

// Wide enough that a real procedure name ("release-checklist") survives the
// icon + scope glyph + version badge without an ellipsis. ELK reads these before
// React Flow measures, so the constant is the single source for layout + hulls.
export const PROC_WIDTH = 178
export const PROC_HEIGHT = 44

/** "1 fact" / "2 facts": a count with its noun agreeing in number. */
export function countLabel(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}
