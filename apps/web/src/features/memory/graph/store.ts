import { create } from 'zustand'
import type {
  EmbeddingProviderInfo,
  LearningEntry,
  MemoryGraphNode,
  MemoryGraphPayload,
} from '@/lib/memoryClient'

// ─── Memory graph store ──────────────────────────────────────────────────────
//
// Dedicated store for the Memory graph surface — five sibling chrome pieces
// (canvas, search bar, legend, inspector, viewport bar) share filters +
// selection, which is too much for MiniGraph-style local state, and the Atlas
// `useGraphStore` singleton is off-limits (its physics/persistence wiring must
// never see memory nodes). One memory view mounts at a time (AnimatePresence
// mode="wait"), so a module-level store is safe; `reset()` runs on unmount so
// stale selections never leak across visits.

export type MemScopeFilter = 'all' | 'global' | 'team' | 'agent'
export type MemTimeFilter = 'all' | '24h' | '7d' | '30d'

interface MemoryGraphState {
  payload: MemoryGraphPayload | null
  provider: EmbeddingProviderInfo | null
  loading: boolean
  error: string | null
  /** Bumped only by setPayload — the canvas re-layouts on this, not on the
   *  payload object identity (learning patches must not re-run ELK). */
  payloadVersion: number
  /** Bump → useMemoryGraphData refetches. */
  refreshKey: number

  // Filters
  hiddenCommunities: Set<number>
  scopeFilter: MemScopeFilter
  /** Recency DIM (not hide) — older nodes fade, layout stays stable. */
  timeFilter: MemTimeFilter
  showHulls: boolean

  // Search
  searchText: string
  /** fact id → score from the Enter ego-search (null = no ego set active). */
  egoHits: Map<string, number> | null

  // Interaction
  selectedNodeId: string | null
  hoveredNodeId: string | null
  /** Hover cascade — hovered node + its adjacency (null = nothing hovered). */
  highlightedNodeIds: Set<string> | null
  locked: boolean
  showMinimap: boolean

  setPayload: (payload: MemoryGraphPayload, provider: EmbeddingProviderInfo | null) => void
  setLoading: (v: boolean) => void
  setError: (e: string | null) => void
  bumpRefresh: () => void
  /** Patch one fact's learning entry in place (feedback loop) WITHOUT bumping
   *  payloadVersion — rings/pills update, layout does not re-run. */
  setNodeLearning: (nodeId: string, learning: LearningEntry | null) => void

  toggleCommunity: (id: number) => void
  setHiddenCommunities: (ids: Set<number>) => void
  setScopeFilter: (f: MemScopeFilter) => void
  setTimeFilter: (f: MemTimeFilter) => void
  setShowHulls: (v: boolean) => void

  setSearchText: (text: string) => void
  setEgoHits: (hits: Map<string, number> | null) => void
  clearSearch: () => void

  select: (id: string | null) => void
  setHovered: (id: string | null) => void
  setLocked: (v: boolean) => void
  setShowMinimap: (v: boolean) => void

  reset: () => void
}

// Adjacency memoized per payload (WeakMap so replaced payloads free their maps).
const adjacencyCache = new WeakMap<MemoryGraphPayload, Map<string, Set<string>>>()

/** Undirected adjacency over the payload's edges — one build per payload,
 *  shared by the hover cascade and the inspector's neighbor chips. */
export function adjacencyOf(payload: MemoryGraphPayload): Map<string, Set<string>> {
  const cached = adjacencyCache.get(payload)
  if (cached) return cached
  const adj = new Map<string, Set<string>>()
  for (const e of payload.edges) {
    let s = adj.get(e.source)
    if (!s) adj.set(e.source, (s = new Set()))
    s.add(e.target)
    let t = adj.get(e.target)
    if (!t) adj.set(e.target, (t = new Set()))
    t.add(e.source)
  }
  adjacencyCache.set(payload, adj)
  return adj
}

export interface NodeIntensityState {
  payload: MemoryGraphPayload | null
  searchText: string
  egoHits: Map<string, number> | null
  hoveredNodeId: string | null
  highlightedNodeIds: Set<string> | null
  selectedNodeId: string | null
  timeFilter: MemTimeFilter
}

const TIME_WINDOW_MS: Record<Exclude<MemTimeFilter, 'all'>, number> = {
  '24h': 24 * 60 * 60 * 1000,
  '7d': 7 * 24 * 60 * 60 * 1000,
  '30d': 30 * 24 * 60 * 60 * 1000,
}

/**
 * The one dim/highlight formula, shared by both node components via a store
 * selector (a changed number is the only thing that re-renders a node).
 * Precedence: selection → ego-search (score-weighted hits, half-intensity
 * neighbors, deep-dim rest) → live substring search → hover cascade; the time
 * filter then caps older nodes at 0.3 (recency highlight, never a hide).
 * Rounded to 2dp to bound re-renders.
 */
export function computeNodeIntensity(
  s: NodeIntensityState,
  node: MemoryGraphNode,
  now: number,
): number {
  let v = 1
  if (s.selectedNodeId === node.id) {
    v = 1
  } else if (s.egoHits) {
    const score = s.egoHits.get(node.id)
    if (score != null) {
      let max = 0
      for (const sc of s.egoHits.values()) if (sc > max) max = sc
      v = 0.45 + 0.55 * (max > 0 ? score / max : 1)
    } else {
      let isNeighbor = false
      if (s.payload) {
        const adj = adjacencyOf(s.payload).get(node.id)
        if (adj) {
          for (const n of adj) {
            if (s.egoHits.has(n)) {
              isNeighbor = true
              break
            }
          }
        }
      }
      v = isNeighbor ? 0.5 : 0.12
    }
  } else if (s.searchText.trim() !== '') {
    const q = s.searchText.trim().toLowerCase()
    const match =
      node.title.toLowerCase().includes(q) || node.tags.some((t) => t.toLowerCase().includes(q))
    v = match ? 1 : 0.15
  } else if (s.hoveredNodeId !== null) {
    v = s.highlightedNodeIds?.has(node.id) ? 1 : 0.22
  }
  if (s.timeFilter !== 'all' && now - node.updatedAt > TIME_WINDOW_MS[s.timeFilter]) {
    v = Math.min(v, 0.3)
  }
  return Math.round(v * 100) / 100
}

// Factory (not a constant) so every reset gets FRESH container instances —
// a shared Set surviving reset would leak state across mount cycles.
const initialState = () => ({
  payload: null as MemoryGraphPayload | null,
  provider: null as EmbeddingProviderInfo | null,
  loading: false,
  error: null as string | null,
  payloadVersion: 0,
  refreshKey: 0,
  hiddenCommunities: new Set<number>(),
  scopeFilter: 'all' as MemScopeFilter,
  timeFilter: 'all' as MemTimeFilter,
  showHulls: true,
  searchText: '',
  egoHits: null as Map<string, number> | null,
  selectedNodeId: null as string | null,
  hoveredNodeId: null as string | null,
  highlightedNodeIds: null as Set<string> | null,
  locked: false,
  showMinimap: false,
})

export const useMemoryGraphStore = create<MemoryGraphState>((set) => ({
  ...initialState(),

  setPayload: (payload, provider) =>
    set((s) => ({
      payload,
      provider,
      error: null,
      payloadVersion: s.payloadVersion + 1,
      // A fresh dataset invalidates id-keyed interaction state.
      selectedNodeId: null,
      hoveredNodeId: null,
      highlightedNodeIds: null,
      egoHits: null,
    })),
  setLoading: (loading) => set({ loading }),
  setError: (error) => set({ error }),
  bumpRefresh: () => set((s) => ({ refreshKey: s.refreshKey + 1 })),

  setNodeLearning: (nodeId, learning) =>
    set((s) => {
      if (!s.payload) return {}
      const nodes = s.payload.nodes.map((n) => (n.id === nodeId ? { ...n, learning } : n))
      const payload = { ...s.payload, nodes }
      // Carry the adjacency over — edges are untouched by a learning patch.
      adjacencyCache.set(payload, adjacencyOf(s.payload))
      return { payload }
    }),

  toggleCommunity: (id) =>
    set((s) => {
      const next = new Set(s.hiddenCommunities)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return { hiddenCommunities: next }
    }),
  setHiddenCommunities: (hiddenCommunities) => set({ hiddenCommunities }),
  setScopeFilter: (scopeFilter) => set({ scopeFilter }),
  setTimeFilter: (timeFilter) => set({ timeFilter }),
  setShowHulls: (showHulls) => set({ showHulls }),

  setSearchText: (searchText) => set({ searchText }),
  setEgoHits: (egoHits) => set({ egoHits }),
  clearSearch: () => set({ searchText: '', egoHits: null }),

  select: (selectedNodeId) => set({ selectedNodeId }),
  setHovered: (id) =>
    set((s) => {
      if (id === null) return { hoveredNodeId: null, highlightedNodeIds: null }
      const highlighted = new Set<string>([id])
      if (s.payload) {
        for (const n of adjacencyOf(s.payload).get(id) ?? []) highlighted.add(n)
      }
      return { hoveredNodeId: id, highlightedNodeIds: highlighted }
    }),
  setLocked: (locked) => set({ locked }),
  setShowMinimap: (showMinimap) => set({ showMinimap }),

  reset: () => set(initialState()),
}))
