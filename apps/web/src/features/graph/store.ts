'use client'

import { create } from 'zustand'
import { applyNodeChanges, applyEdgeChanges } from '@xyflow/react'
import type { NodeChange, EdgeChange } from '@xyflow/react'
import type { GraphNode, GraphEdge, LayoutData } from './types'

// ─── Store shape ──────────────────────────────────────────────────────────────

interface GraphStore {
  // Agent file cache (fetched from Gateway)
  agentFiles: Map<string, { toolsMd: string | null; agentsMd: string | null }>
  isLoadingFiles: boolean
  filesError: string | null

  // ReactFlow state
  nodes: GraphNode[]
  edges: GraphEdge[]
  hasRunLayout: boolean

  // Incremented by resetLayout() — triggers ELK re-run in GhostGraph
  layoutKey: number

  // Edge selected for "Explain this edge" panel
  selectedEdgeId: string | null

  // User-dragged positions (persisted to SQLite)
  savedPositions: LayoutData['positions']

  // ─── Actions ────────────────────────────────────────────────────────────────

  setAgentFiles: (
    agentId: string,
    files: { toolsMd?: string | null; agentsMd?: string | null },
  ) => void
  setLoadingFiles: (v: boolean) => void
  setFilesError: (e: string | null) => void

  setNodes: (nodes: GraphNode[]) => void
  setEdges: (edges: GraphEdge[]) => void
  setHasRunLayout: (v: boolean) => void

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
  layoutKey: 0,

  selectedEdgeId: null,
  savedPositions: {},

  setAgentFiles: (agentId, files) =>
    set((state) => {
      const next = new Map(state.agentFiles)
      const existing = next.get(agentId) ?? { toolsMd: null, agentsMd: null }
      next.set(agentId, { ...existing, ...files })
      return { agentFiles: next }
    }),

  setLoadingFiles: (v) => set({ isLoadingFiles: v }),
  setFilesError: (e) => set({ filesError: e }),

  setNodes: (nodes) => set({ nodes }),
  setEdges: (edges) => set({ edges }),
  setHasRunLayout: (v) => set({ hasRunLayout: v }),

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
