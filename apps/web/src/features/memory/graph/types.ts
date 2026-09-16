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
  /** Shared endpoint community color (both ends in one community), else null. */
  communityColor: string | null
}

export type MemNodeData = MemFactData | MemProcData
export type MemFlowNode = Node<MemNodeData>
export type MemFlowEdge = Edge<MemEdgeData>

export const PROC_WIDTH = 150
export const PROC_HEIGHT = 44

/** "1 fact" / "2 facts": a count with its noun agreeing in number. */
export function countLabel(n: number, singular: string, plural = `${singular}s`): string {
  return `${n} ${n === 1 ? singular : plural}`
}

/** Community → palette var (8-color cycle; both themes define --mem-c0..c7). */
export function communityColor(community: number): string {
  return `var(--mem-c${((community % 8) + 8) % 8})`
}
