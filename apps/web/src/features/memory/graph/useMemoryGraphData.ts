// Data plumbing for the Memory graph: a fetch effect keyed on the store's
// refreshKey, and the pure payload → React Flow element builder.
//
// Filtering contract: community-hidden and scope-filtered nodes get RF
// `hidden: true` (and every edge touching a hidden node hides with them);
// `timeFilter` and the search states do NOT change the element array — they
// only dim via store-subscribed styles inside the node components, so the ELK
// layout stays stable and re-runs only when the payload changes.

import { useEffect } from 'react'
import { fetchMemoryGraph, type MemoryGraphPayload } from '@/lib/memoryClient'
import { useMemoryGraphStore, type MemScopeFilter } from './store'
import {
  communityColor,
  PROC_HEIGHT,
  PROC_WIDTH,
  type MemFlowEdge,
  type MemFlowNode,
} from './types'

export interface MemoryFlowFilters {
  hiddenCommunities: Set<number>
  scopeFilter: MemScopeFilter
}

/** Degree-scaled disc diameter, so hub facts read bigger at a glance. */
export function factDiameter(degree: number, maxDegree: number): number {
  const ratio = maxDegree > 0 ? degree / maxDegree : 0
  return Math.round(34 + 26 * Math.sqrt(ratio))
}

export function buildMemoryFlowElements(
  payload: MemoryGraphPayload,
  filters: MemoryFlowFilters,
): { nodes: MemFlowNode[]; edges: MemFlowEdge[] } {
  const maxDegree = payload.nodes.reduce((m, n) => Math.max(m, n.degree), 0)
  const degreesAsc = payload.nodes.map((n) => n.degree).sort((a, b) => a - b)
  const degreeP75 =
    degreesAsc.length > 0 ? degreesAsc[Math.floor(0.75 * (degreesAsc.length - 1))]! : 0

  const isHidden = (community: number, scope: string): boolean =>
    filters.hiddenCommunities.has(community) ||
    (filters.scopeFilter !== 'all' && scope !== filters.scopeFilter)

  const nodes: MemFlowNode[] = payload.nodes.map((n) => {
    const hidden = isHidden(n.community, n.scope)
    if (n.kind === 'procedure') {
      return {
        id: n.id,
        type: 'memProc',
        position: { x: 0, y: 0 },
        width: PROC_WIDTH,
        height: PROC_HEIGHT,
        hidden,
        data: { node: n },
      }
    }
    const diameter = factDiameter(n.degree, maxDegree)
    return {
      id: n.id,
      type: 'memFact',
      position: { x: 0, y: 0 },
      width: diameter,
      height: diameter,
      hidden,
      data: { node: n, diameter, degreeP75 },
    }
  })

  const hiddenIds = new Set(nodes.filter((n) => n.hidden).map((n) => n.id))
  const communityOf = new Map(payload.nodes.map((n) => [n.id, n.community]))
  const edges: MemFlowEdge[] = payload.edges.map((e) => {
    const cs = communityOf.get(e.source)
    const ct = communityOf.get(e.target)
    return {
      id: e.id,
      source: e.source,
      target: e.target,
      type: 'memory',
      hidden: hiddenIds.has(e.source) || hiddenIds.has(e.target),
      data: {
        kind: e.kind,
        weight: e.weight,
        sharedTags: e.sharedTags,
        communityColor: cs != null && cs === ct ? communityColor(cs) : null,
      },
    }
  })

  return { nodes, edges }
}

/** Fetches the graph into the store on mount and whenever refreshKey bumps. */
export function useMemoryGraphData(): void {
  const refreshKey = useMemoryGraphStore((s) => s.refreshKey)

  useEffect(() => {
    let cancelled = false
    useMemoryGraphStore.getState().setLoading(true)
    void fetchMemoryGraph().then((res) => {
      if (cancelled) return
      const store = useMemoryGraphStore.getState()
      store.setLoading(false)
      if (!res) store.setError('Could not load the memory graph.')
      else store.setPayload(res.graph, res.provider)
    })
    return () => {
      cancelled = true
    }
  }, [refreshKey])
}
