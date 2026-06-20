import { create } from 'zustand'
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react'
import type { NodeChange, EdgeChange } from '@xyflow/react'
import type { CapabilityRecord } from '@clawboo/capability-registry'
import type { GraphNode, GraphEdge, LayoutData } from './types'

// ─── Store shape ──────────────────────────────────────────────────────────────

interface GraphStore {
  // Per-agent graph inputs: the agent-scoped capability records (the unified
  // inventory — supersedes the legacy per-agent markdown skill-file path) +
  // AGENTS.md routing (still drives dependency edges).
  agentFiles: Map<string, { capabilities: CapabilityRecord[] | null; agentsMd: string | null }>
  isLoadingFiles: boolean
  filesError: string | null

  // ReactFlow state
  nodes: GraphNode[]
  edges: GraphEdge[]
  hasRunLayout: boolean

  // Which scope the current `nodes` were last STRUCTURALLY built for, e.g.
  // `team:<id>` or `atlas`. `null` while cleared/rebuilding. The global store is
  // shared across Atlas + every team graph, so a consumer (the team chat header's
  // boo/skill count) reads this to avoid showing a stale count from the PREVIOUS
  // scope's nodes before the current team's graph hydrates.
  graphScopeKey: string | null

  // Incremented by resetLayout() — triggers ELK re-run in GhostGraph
  layoutKey: number

  // Edge selected for "Explain this edge" panel
  selectedEdgeId: string | null

  // User-dragged positions (persisted to SQLite)
  savedPositions: LayoutData['positions']

  // ─── Actions ────────────────────────────────────────────────────────────────

  setAgentFiles: (
    agentId: string,
    files: { capabilities?: CapabilityRecord[] | null; agentsMd?: string | null },
  ) => void
  setLoadingFiles: (v: boolean) => void
  setFilesError: (e: string | null) => void

  setNodes: (nodes: GraphNode[]) => void
  setEdges: (edges: GraphEdge[]) => void
  setHasRunLayout: (v: boolean) => void
  /** Record which scope the just-committed `nodes` belong to (or null when cleared). */
  setGraphScopeKey: (key: string | null) => void

  onNodesChange: (changes: NodeChange<GraphNode>[]) => void
  onEdgesChange: (changes: EdgeChange<GraphEdge>[]) => void

  setSelectedEdgeId: (id: string | null) => void
  updateNodePosition: (nodeId: string, pos: { x: number; y: number }) => void
  setSavedPositions: (positions: LayoutData['positions']) => void

  /** Clear saved positions and bump layoutKey → forces fresh ELK auto-layout. */
  resetLayout: () => void

  /** Bump to trigger agent file re-fetch in useGraphData. */
  refreshKey: number
  triggerRefresh: () => void

  /** When true, BooNode handles are always visible for easier edge drawing. */
  connectMode: boolean
  setConnectMode: (v: boolean) => void

  /** When true, colored convex-hull halos render behind team groupings. */
  showTeamHalos: boolean
  setShowTeamHalos: (v: boolean) => void

  /**
   * Atlas topology. `top-down` (default) is the original flat-row
   * org chart with BZ at top and team-roots in a horizontal line; `radial`
   * puts BZ at the centre with teams as petals. Persisted to localStorage.
   */
  atlasLayout: 'top-down' | 'radial'
  setAtlasLayout: (v: 'top-down' | 'radial') => void

  /**
   * Set of Boo NODE IDs (e.g. `boo-<agentId>`) whose orbital children
   * (skill + resource nodes) are currently expanded in the Ghost Graph.
   * Default is empty — every Boo's orbital children are HIDDEN at rest,
   * keeping the canvas focused on the team topology (boos + dependency
   * edges + halos). Single-click on a Boo toggles its presence in this
   * Set, triggering the peacock-feather expand / collapse animation.
   *
   * Only consumed by the main Ghost Graph; the per-agent MiniGraph keeps
   * its skills always visible because it doesn't subscribe to this state.
   */
  expandedBooNodeIds: Set<string>
  setExpandedBooNodeIds: (ids: Set<string>) => void
  toggleBooNodeExpanded: (booNodeId: string) => void
  collapseAllBooNodes: () => void

  /** Hover cascade — highlights hovered node's cluster, dims everything else. */
  hoveredNodeId: string | null
  highlightedNodeIds: Set<string> | null
  highlightedEdgeIds: Set<string> | null
  setHoveredNodeId: (id: string | null) => void

  /** Called by physics engine when a Boo node is dragged. Set by GhostGraph on mount. */
  _physicsWakeCallback: (() => void) | null
  setPhysicsWakeCallback: (cb: (() => void) | null) => void
}

// ─── Store instance ───────────────────────────────────────────────────────────

export const useGraphStore = create<GraphStore>((set) => ({
  agentFiles: new Map(),
  isLoadingFiles: false,
  filesError: null,

  nodes: [],
  edges: [],
  hasRunLayout: false,
  graphScopeKey: null,
  layoutKey: 0,

  selectedEdgeId: null,
  savedPositions: {},

  setAgentFiles: (agentId, files) =>
    set((state) => {
      const next = new Map(state.agentFiles)
      const existing = next.get(agentId) ?? { capabilities: null, agentsMd: null }
      next.set(agentId, { ...existing, ...files })
      return { agentFiles: next }
    }),

  setLoadingFiles: (v) => set({ isLoadingFiles: v }),
  setFilesError: (e) => set({ filesError: e }),

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  setHasRunLayout: (v) => set({ hasRunLayout: v }),
  setGraphScopeKey: (key) => set({ graphScopeKey: key }),

  onNodesChange: (changes) => {
    const cb = useGraphStore.getState()._physicsWakeCallback
    const shouldWake =
      cb &&
      changes.some(
        (c) => c.type === 'position' && c.id.startsWith('boo-') && 'position' in c && c.position,
      )
    set((state) => ({
      nodes: applyNodeChanges(changes, state.nodes) as GraphNode[],
    }))
    if (shouldWake && cb) cb()
  },

  onEdgesChange: (changes) =>
    set((state) => ({
      edges: applyEdgeChanges(changes, state.edges) as GraphEdge[],
    })),

  setSelectedEdgeId: (id) => set({ selectedEdgeId: id }),

  updateNodePosition: (nodeId, pos) =>
    set((state) => ({
      savedPositions: { ...state.savedPositions, [nodeId]: pos },
    })),

  setSavedPositions: (positions) => set({ savedPositions: positions }),

  resetLayout: () =>
    set((state) => ({
      savedPositions: {},
      hasRunLayout: false,
      layoutKey: state.layoutKey + 1,
    })),

  refreshKey: 0,
  triggerRefresh: () => set((state) => ({ refreshKey: state.refreshKey + 1 })),

  connectMode: false,
  setConnectMode: (v) => set({ connectMode: v }),

  showTeamHalos: false,
  setShowTeamHalos: (v) => set({ showTeamHalos: v }),

  // Atlas defaults to **Radial** — Boo Zero at the center with teams
  // distributed on a circle around it. The `'top-down'` (Tree) variant is
  // still available via the canvas toolbar pill; an explicit user choice
  // persists in localStorage and overrides the default.
  atlasLayout:
    typeof window !== 'undefined' &&
    window.localStorage.getItem('clawboo.atlas.layout') === 'top-down'
      ? 'top-down'
      : 'radial',
  setAtlasLayout: (v) => {
    if (typeof window !== 'undefined') {
      window.localStorage.setItem('clawboo.atlas.layout', v)
    }
    set({ atlasLayout: v })
  },

  expandedBooNodeIds: new Set(),
  setExpandedBooNodeIds: (ids) => set({ expandedBooNodeIds: new Set(ids) }),
  toggleBooNodeExpanded: (booNodeId) =>
    set((state) => {
      const next = new Set(state.expandedBooNodeIds)
      if (next.has(booNodeId)) {
        next.delete(booNodeId)
      } else {
        next.add(booNodeId)
      }
      return { expandedBooNodeIds: next }
    }),
  collapseAllBooNodes: () => set({ expandedBooNodeIds: new Set() }),

  _physicsWakeCallback: null,
  setPhysicsWakeCallback: (cb) => set({ _physicsWakeCallback: cb }),

  hoveredNodeId: null,
  highlightedNodeIds: null,
  highlightedEdgeIds: null,
  setHoveredNodeId: (id) =>
    set((state) => {
      if (id === null) {
        return { hoveredNodeId: null, highlightedNodeIds: null, highlightedEdgeIds: null }
      }
      const connectedNodes = new Set<string>([id])
      const connectedEdges = new Set<string>()
      for (const edge of state.edges) {
        if (edge.source === id || edge.target === id) {
          connectedNodes.add(edge.source)
          connectedNodes.add(edge.target)
          connectedEdges.add(edge.id)
        }
      }
      return {
        hoveredNodeId: id,
        highlightedNodeIds: connectedNodes,
        highlightedEdgeIds: connectedEdges,
      }
    }),
}))
