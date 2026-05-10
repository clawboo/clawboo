import '@xyflow/react/dist/style.css'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  useNodesInitialized,
  useReactFlow,
} from '@xyflow/react'
import type {
  NodeMouseHandler,
  EdgeMouseHandler,
  OnNodeDrag,
  Node,
  Connection,
  IsValidConnection,
  MiniMapNodeProps,
} from '@xyflow/react'
import { motion, AnimatePresence } from 'framer-motion'
import { GitBranch, Pin } from 'lucide-react'
import { useGraphStore } from './store'
import { useGraphData } from './useGraphData'
import { useGraphPersistence } from './useGraphPersistence'
import { computeElkLayout } from './useGraphLayout'
import { computeOrbitalPositions } from './computeOrbitalPositions'
import { nodeTypes } from './nodes/nodeTypes'
import { edgeTypes } from './edges/edgeTypes'
import { ConnectionLine } from './edges/ConnectionLine'
import { TeamHaloLayer } from './TeamHaloLayer'
import { useFleetStore } from '@/stores/fleet'
import { useViewStore } from '@/stores/view'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { mutationQueue } from '@/lib/mutationQueue'
import { deleteAgentOperation } from '@/features/fleet/deleteAgentOperation'
import { GraphContextMenu } from './GraphContextMenu'
import { installSkillForAgent } from './operations/installSkill'
import { removeRouting } from './operations/removeRouting'
import { graphPhysics } from './graphPhysics'
import { EdgeMarkers } from './edges/EdgeMarkers'
import type { BooNodeData, SkillNodeData, GraphEdge } from './types'

interface ContextMenuState {
  x: number
  y: number
  agentId: string
  agentName: string
}

// Custom MiniMap node renderer.
//
// React Flow's default MiniMap draws each node at its actual rendered size.
// Our BooNode is a 340×340 transparent footprint with the visible Boo
// (~80px circle / 220×120 card) centered inside it — see BOO_FOOTPRINT in
// nodes/BooNode.tsx. Rendering the full footprint in the MiniMap makes Boos
// look enormously out of proportion vs. the actual visible shape on the
// canvas. This component draws Boos as a smaller centered dot so the MiniMap
// reflects what the user actually sees. Skill / resource nodes already
// render at sensible visual sizes, so they're drawn at their measured size.
function GhostGraphMiniMapNode({
  id,
  x,
  y,
  width,
  height,
  color,
  borderRadius,
  className,
  shapeRendering,
  strokeColor,
  strokeWidth,
  selected,
}: MiniMapNodeProps) {
  const fill = color ?? '#e2e2e2'
  if (color === 'transparent') return null
  const stroke = strokeColor ?? 'transparent'
  const sw = strokeWidth ?? 0
  if (id.startsWith('boo-')) {
    // Visible Boo is roughly 80–120 px on canvas; pick 110 as a single
    // representative size that reads well in MiniMap regardless of whether
    // the source Boo is in idle-circle or active-card mode.
    const visualSize = 110
    return (
      <circle
        cx={x + width / 2}
        cy={y + height / 2}
        r={visualSize / 2}
        fill={fill}
        stroke={stroke}
        strokeWidth={sw}
        shapeRendering={shapeRendering}
        className={className + (selected ? ' selected' : '')}
      />
    )
  }
  return (
    <rect
      x={x}
      y={y}
      width={width}
      height={height}
      rx={borderRadius}
      ry={borderRadius}
      fill={fill}
      stroke={stroke}
      strokeWidth={sw}
      shapeRendering={shapeRendering}
      className={className + (selected ? ' selected' : '')}
    />
  )
}

// ─── GhostGraph ───────────────────────────────────────────────────────────────
//
// Must be rendered inside <ReactFlowProvider> (done by GhostGraphPanel).

export function GhostGraph() {
  const {
    nodes,
    edges,
    onNodesChange,
    onEdgesChange,
    savedPositions,
    layoutKey,
    selectedEdgeId,
    setSelectedEdgeId,
    setNodes,
    hasRunLayout,
    setHasRunLayout,
    updateNodePosition,
    connectMode,
    setConnectMode,
    showTeamHalos,
    setShowTeamHalos,
    setHoveredNodeId,
  } = useGraphStore()

  // Subscribed separately so the visibility memo only re-runs when the Set
  // identity changes — not on every nodes/edges update from physics ticks.
  const expandedBooNodeIds = useGraphStore((s) => s.expandedBooNodeIds)

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const nodesInitialized = useNodesInitialized()
  const { fitView } = useReactFlow()

  // Track the canvas wrapper size so we can (a) re-fit the graph when the
  // panel is resized (e.g. user drags the divider in the new vertical group
  // chat layout) and (b) size the MiniMap proportionally to the canvas.
  const wrapperRef = useRef<HTMLDivElement>(null)
  const [containerSize, setContainerSize] = useState<{ w: number; h: number }>({ w: 800, h: 600 })

  // Track layout state in refs to avoid stale closure issues
  const layoutRanRef = useRef(false)
  const prevNodeLengthRef = useRef(0)
  const elkGenerationRef = useRef(0)
  const prevLayoutKeyRef = useRef(layoutKey)

  // Wire data fetching and persistence
  useGraphData()
  const { savePositions, isLoaded } = useGraphPersistence()

  // Wire physics wake callback — when a boo node is dragged, wake the physics engine
  useEffect(() => {
    useGraphStore.getState().setPhysicsWakeCallback(() => graphPhysics.wake())
    return () => {
      useGraphStore.getState().setPhysicsWakeCallback(null)
      graphPhysics.dispose()
    }
  }, [])

  // Observe the canvas wrapper so we can refit + resize the MiniMap when the
  // surrounding panel changes shape (group chat divider drag, window resize,
  // navigating into / out of group chat with its short-and-wide row layout).
  useEffect(() => {
    const el = wrapperRef.current
    if (!el) return
    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        const { width, height } = entry.contentRect
        if (width > 0 && height > 0) {
          setContainerSize((prev) =>
            Math.abs(prev.w - width) < 0.5 && Math.abs(prev.h - height) < 0.5
              ? prev
              : { w: width, h: height },
          )
        }
      }
    })
    ro.observe(el)
    return () => ro.disconnect()
  }, [])

  // Refit the view when the container size changes (debounced). Only fires
  // after the initial layout has run, otherwise the layout effect already
  // calls fitView once Boos land. Skipped on the very first dimensions read
  // (matches the initial 800×600 default → no spurious refit on mount).
  const refitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  const initialFitDoneRef = useRef(false)
  useEffect(() => {
    if (!hasRunLayout) return
    if (!initialFitDoneRef.current) {
      initialFitDoneRef.current = true
      return
    }
    if (refitTimerRef.current) clearTimeout(refitTimerRef.current)
    refitTimerRef.current = setTimeout(() => {
      void fitView({ padding: 0.08, duration: 250, maxZoom: 1.5 })
    }, 180)
    return () => {
      if (refitTimerRef.current) clearTimeout(refitTimerRef.current)
    }
  }, [containerSize.w, containerSize.h, hasRunLayout, fitView])

  // MiniMap stays small relative to the canvas — ~16% wide, ~22% tall, with
  // sensible min/max so it neither becomes invisible on tiny panels nor
  // dominates the canvas on large ones.
  const minimapDims = useMemo(() => {
    const w = Math.round(Math.max(110, Math.min(180, containerSize.w * 0.16)))
    const h = Math.round(Math.max(72, Math.min(130, containerSize.h * 0.22)))
    return { w, h }
  }, [containerSize.w, containerSize.h])

  // ── Two-layer auto-layout ────────────────────────────────────────────────────
  // Layer 1: ELK positions boo nodes using dependency edges only (async).
  // Layer 2: Orbital positions skill/resource nodes around their parent boo (sync).
  // Re-runs when node count changes or user clicks "Re-layout" (layoutKey bump).
  useEffect(() => {
    // Reset when layoutKey bumps (user pressed "Re-layout").
    // Must happen INSIDE this effect (not a separate one) to ensure the reset
    // is processed before the guard check — React runs effects in definition order.
    if (layoutKey !== prevLayoutKeyRef.current) {
      prevLayoutKeyRef.current = layoutKey
      layoutRanRef.current = false
      prevNodeLengthRef.current = 0
    }

    if (!nodesInitialized || nodes.length === 0 || !isLoaded) return

    // Reset when node count changes (new agents added)
    if (nodes.length !== prevNodeLengthRef.current) {
      prevNodeLengthRef.current = nodes.length
      layoutRanRef.current = false
    }

    if (layoutRanRef.current) return
    layoutRanRef.current = true

    // Increment generation only when actually starting ELK computation.
    const generation = ++elkGenerationRef.current

    // Layer 1: Only boo nodes + PRIMARY dependency edges go through ELK.
    // Secondary edges (every routing rule outside the spanning tree from
    // the team leader) are intentionally withheld — feeding them to ELK
    // would re-introduce the edge-tangle that obscured the leader →
    // teammate flow. Secondary edges are still rendered, but only on
    // hover, and they don't influence layout.
    const booNodes = nodes.filter((n) => n.type === 'boo')
    const nonBooNodes = nodes.filter((n) => n.type !== 'boo')
    const primaryDepEdges = edges.filter(
      (e) => e.type === 'dependency' && (e.data as { isPrimary?: boolean })?.isPrimary !== false,
    )

    void computeElkLayout(booNodes, primaryDepEdges, savedPositions).then((layoutedBooNodes) => {
      // Skip stale results — a newer ELK computation has started
      if (generation !== elkGenerationRef.current) return

      // Layer 2: Position skills/resources in orbital arcs around their parent boo
      const orbitalNodes = computeOrbitalPositions(
        layoutedBooNodes,
        nonBooNodes,
        edges, // full edges needed for parent-child mapping
        savedPositions,
      )

      setNodes([...layoutedBooNodes, ...orbitalNodes])
      setHasRunLayout(true)

      // Initialize physics particles from layouted positions
      requestAnimationFrame(() => {
        const current = useGraphStore.getState()
        graphPhysics.initialize(current.nodes, current.edges)
      })

      requestAnimationFrame(() => {
        // Tight padding gives Boos visual prominence; maxZoom caps the fit so
        // tiny graphs (1–2 Boos) don't blow up to fill the canvas.
        void fitView({ padding: 0.08, duration: 500, maxZoom: 1.5 })
      })
    })
    // isLoaded gates layout until saved positions are fetched from SQLite.
  }, [nodesInitialized, nodes.length, layoutKey, isLoaded])

  // ── Interaction handlers ─────────────────────────────────────────────────────

  const onNodeDragStart: OnNodeDrag<Node> = useCallback((_event, node) => {
    if (node.type === 'skill' || node.type === 'resource' || node.type === 'boo') {
      graphPhysics.pinNode(node.id)
    }
  }, [])

  const onNodeDragStop: OnNodeDrag<Node> = useCallback(
    (_event, node) => {
      updateNodePosition(node.id, node.position)
      const currentSaved = useGraphStore.getState().savedPositions
      savePositions({ ...currentSaved, [node.id]: node.position })

      if (node.type === 'skill' || node.type === 'resource' || node.type === 'boo') {
        graphPhysics.unpinNode(node.id)
      }
    },
    [updateNodePosition, savePositions],
  )

  const onEdgeClick: EdgeMouseHandler = useCallback(
    (_event, edge) => {
      setSelectedEdgeId(selectedEdgeId === edge.id ? null : edge.id)
    },
    [selectedEdgeId, setSelectedEdgeId],
  )

  // Single-click on a Boo toggles its orbital children (skills + resources)
  // visibility — peacock-feather expand / collapse. The previous left-click
  // behaviour of "select agent in the sidebar" is now available from the
  // right-click context menu (`Select in sidebar` item) and is also implicit
  // when the user picks Chat / Edit personality / Edit files there.
  const onNodeClick: NodeMouseHandler<Node> = useCallback((_event, node) => {
    if (node.type === 'boo') {
      useGraphStore.getState().toggleBooNodeExpanded(node.id)
    }
  }, [])

  const onNodeContextMenu = useCallback((event: React.MouseEvent, node: Node) => {
    event.preventDefault()
    if (node.type !== 'boo') return
    const data = node.data as BooNodeData
    setContextMenu({
      x: event.clientX,
      y: event.clientY,
      agentId: data.agentId,
      agentName: data.name,
    })
  }, [])

  // ── Hover cascade handlers ────────────────────────────────────────────────
  const onNodeMouseEnter: NodeMouseHandler<Node> = useCallback(
    (_event, node) => {
      setHoveredNodeId(node.id)
    },
    [setHoveredNodeId],
  )

  const onNodeMouseLeave: NodeMouseHandler<Node> = useCallback(() => {
    setHoveredNodeId(null)
  }, [setHoveredNodeId])

  const onConnect = useCallback(
    async (connection: Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source)
      const targetNode = nodes.find((n) => n.id === connection.target)
      if (!sourceNode || !targetNode) return

      // Skill-to-Boo: drag a SkillNode onto a BooNode to install
      if (sourceNode.type === 'skill' && targetNode.type === 'boo') {
        const skillData = sourceNode.data as SkillNodeData
        const booData = targetNode.data as BooNodeData
        void installSkillForAgent(skillData.name, booData.agentId, booData.name)
        return
      }

      if (sourceNode.type !== 'boo' || targetNode.type !== 'boo') return

      const sourceAgentId = sourceNode.data.agentId as string
      const sourceAgentName = sourceNode.data.name as string
      const targetAgentName = targetNode.data.name as string

      const client = useConnectionStore.getState().client
      if (!client) return

      // Check for existing edge before adding
      const existingEdge = useGraphStore
        .getState()
        .edges.find(
          (e) =>
            e.source === connection.source &&
            e.target === connection.target &&
            e.type === 'dependency',
        )
      if (existingEdge) {
        useToastStore.getState().addToast({
          message: `${targetAgentName} already in routing`,
          type: 'info',
        })
        return
      }

      // Optimistically add edge to graph immediately
      const targetAgentId = (targetNode.data as BooNodeData).agentId
      const optimisticEdge: GraphEdge = {
        id: `dep-${sourceAgentId}-${targetAgentId}`,
        type: 'dependency',
        source: connection.source,
        sourceHandle: 'center',
        target: connection.target,
        targetHandle: 'center-target',
        data: {},
      }
      const store = useGraphStore.getState()
      store.setEdges([...store.edges, optimisticEdge])

      try {
        const currentAgentsMd = await client.agents.files
          .read(sourceAgentId, 'AGENTS.md')
          .catch(() => '# AGENTS\n')

        if (currentAgentsMd.includes('@' + targetAgentName)) {
          // Already in file, edge is correct — just notify
          useToastStore.getState().addToast({
            message: `${targetAgentName} already in routing`,
            type: 'info',
          })
          return
        }

        const newAgentsMd =
          currentAgentsMd.trimEnd() + '\n- Route to @' + targetAgentName + ' for delegated tasks.\n'
        await mutationQueue.enqueue(sourceAgentId, () =>
          client.agents.files.set(sourceAgentId, 'AGENTS.md', newAgentsMd),
        )

        // Update local agentFiles cache so the structural rebuild in useGraphData
        // naturally includes this edge. Do NOT call triggerRefresh() here — that
        // triggers a full async re-fetch which overwrites edges (including our
        // optimistic one) before the Gateway has time to persist.
        useGraphStore.getState().setAgentFiles(sourceAgentId, { agentsMd: newAgentsMd })

        useToastStore.getState().addToast({
          message: `Routing added: ${sourceAgentName} \u2192 ${targetAgentName}`,
          type: 'success',
        })

        // Ensure agent-to-agent coordination is enabled in Gateway config (idempotent)
        fetch('/api/system/openclaw-config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentToAgent: { enabled: true } }),
        }).catch(() => {
          // non-fatal — user can enable manually in System panel
        })
      } catch (_err) {
        // Rollback optimistic edge on failure
        const current = useGraphStore.getState()
        current.setEdges(current.edges.filter((e) => e.id !== optimisticEdge.id))
        useToastStore.getState().addToast({
          message: 'Failed to save routing',
          type: 'error',
        })
      }
    },
    [nodes],
  )

  const isValidConnection: IsValidConnection = useCallback(
    (connection) => {
      const source = nodes.find((n) => n.id === connection.source)
      const target = nodes.find((n) => n.id === connection.target)
      if (source?.type === 'skill' && target?.type === 'boo') return true
      return source?.type === 'boo' && target?.type === 'boo' && source.id !== target.id
    },
    [nodes],
  )

  const onPaneClick = useCallback(() => {
    setSelectedEdgeId(null)
    setContextMenu(null)
    setHoveredNodeId(null)
  }, [setSelectedEdgeId, setHoveredNodeId])

  const handleDeleteEdge = useCallback(
    async (edgeId: string) => {
      const edge = edges.find((e) => e.id === edgeId)
      if (!edge || edge.type !== 'dependency') return

      const sourceAgentId = edge.source.startsWith('boo-') ? edge.source.slice(4) : null
      const targetAgentId = edge.target.startsWith('boo-') ? edge.target.slice(4) : null
      if (!sourceAgentId || !targetAgentId) return

      setSelectedEdgeId(null)
      await removeRouting(edgeId, sourceAgentId, targetAgentId)
    },
    [edges, setSelectedEdgeId],
  )

  // ── Derive selected edge for explain panel ───────────────────────────────────
  const selectedEdge = selectedEdgeId ? (edges.find((e) => e.id === selectedEdgeId) ?? null) : null

  // ── Derive visibility for skill/resource nodes + their edges ──────────────
  // Boos and dependency edges are always visible. Skill / resource nodes are
  // hidden by default and revealed only when the user clicks (and thus
  // expands) their parent Boo.
  //
  // Two different visibility mechanisms:
  //   • EDGES use React Flow's native `hidden: true` — fastest path, no
  //     animation needed (the edge just disappears when its parent Boo
  //     collapses).
  //   • NODES use a `data.isVisible` flag we read inside SkillNode /
  //     ResourceNode. We DON'T use React Flow's `hidden: true` for nodes
  //     because that maps to `display: none`, which is non-animatable —
  //     and we want the peacock-feather expand / collapse transition.
  //     Hidden nodes stay mounted with `opacity: 0` + `scale: 0`, animated
  //     by Framer Motion in the node component.
  //
  // Parent Boo IDs are derived from the existing source-of-truth (the
  // node's `agentIds[0]` for skill/resource nodes; the edge's `source` for
  // skill/resource edges) — no `buildGraphElements` change needed.
  const visibleNodes = useMemo<typeof nodes>(() => {
    if (nodes.length === 0) return nodes
    return nodes.map((n) => {
      if (n.type === 'boo') {
        return (n.hidden ? { ...n, hidden: false } : n) as typeof n
      }
      if (n.type !== 'skill' && n.type !== 'resource') return n
      const ownerAgentId = n.data.agentIds?.[0]
      const parentBooId = ownerAgentId ? `boo-${ownerAgentId}` : null
      const isVisible = !!parentBooId && expandedBooNodeIds.has(parentBooId)
      if (n.data.isVisible === isVisible) return n
      // Always keep skill/resource nodes mounted (`hidden` never set);
      // visibility is animated inside the node component via `data.isVisible`.
      // The cast keeps the discriminated union narrow per branch.
      return { ...n, data: { ...n.data, isVisible } } as typeof n
    })
  }, [nodes, expandedBooNodeIds])

  const visibleEdges = useMemo(() => {
    if (edges.length === 0) return edges
    return edges.map((e) => {
      if (e.type === 'dependency') {
        return e.hidden ? { ...e, hidden: false } : e
      }
      if (e.type !== 'skill' && e.type !== 'resource') return e
      // Skill / resource edges always have the parent Boo as `source`.
      const shouldBeHidden = !expandedBooNodeIds.has(e.source)
      if (e.hidden === shouldBeHidden) return e
      return { ...e, hidden: shouldBeHidden }
    })
  }, [edges, expandedBooNodeIds])

  return (
    <div
      ref={wrapperRef}
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        // Background moved here from <ReactFlow> so TeamHaloLayer can render
        // between the wrapper bg and ReactFlow's transparent canvas.
        background: '#0A0E1A',
        // Hide nodes until ELK has positioned them — prevents (0,0) pile-up flash on new teams
        opacity: hasRunLayout ? 1 : 0,
        transition: 'opacity 0.25s ease',
      }}
    >
      {/* SVG marker definitions referenced by edges (e.g.
          DependencyEdge's `markerEnd="url(#dependency-arrow)"`).
          Mounted once — marker IDs are global to the document. */}
      <EdgeMarkers />

      {/* Team halos layer — behind ReactFlow, matches pane pan/zoom */}
      {showTeamHalos && <TeamHaloLayer nodes={nodes} />}

      {/* Team halos toggle */}
      <button
        onClick={() => setShowTeamHalos(!showTeamHalos)}
        title="Toggle colored team hulls behind agents"
        style={{
          position: 'absolute',
          top: 12,
          right: 112,
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          border: showTeamHalos
            ? '1px solid rgba(52,211,153,0.4)'
            : '1px solid rgba(255,255,255,0.1)',
          background: showTeamHalos ? 'rgba(52,211,153,0.18)' : '#111827',
          color: showTeamHalos ? '#34D399' : 'rgba(232,232,232,0.5)',
          transition: 'all 0.15s',
        }}
      >
        <Pin size={14} />
        Team halos
      </button>

      {/* Connect mode toggle */}
      <button
        onClick={() => setConnectMode(!connectMode)}
        style={{
          position: 'absolute',
          top: 12,
          right: 12,
          zIndex: 20,
          display: 'flex',
          alignItems: 'center',
          gap: 6,
          padding: '6px 12px',
          borderRadius: 8,
          fontSize: 12,
          fontWeight: 600,
          cursor: 'pointer',
          border: connectMode ? '1px solid rgba(233,69,96,0.4)' : '1px solid rgba(255,255,255,0.1)',
          background: connectMode ? 'rgba(233,69,96,0.2)' : '#111827',
          color: connectMode ? '#E94560' : 'rgba(232,232,232,0.5)',
          transition: 'all 0.15s',
        }}
      >
        <GitBranch size={14} />
        {connectMode ? 'Drawing Edges' : 'Connect'}
      </button>

      <ReactFlow
        nodes={visibleNodes}
        edges={visibleEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStart={onNodeDragStart}
        onNodeDragStop={onNodeDragStop}
        onEdgeClick={onEdgeClick}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        onPaneClick={onPaneClick}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        connectOnClick={true}
        connectionLineComponent={ConnectionLine}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        style={{ background: 'transparent' }}
        minZoom={0.15}
        maxZoom={2.5}
        defaultEdgeOptions={{ animated: false }}
      >
        <Background
          variant={BackgroundVariant.Dots}
          gap={32}
          size={1}
          color="rgba(255,255,255,0.03)"
        />
        <Controls
          style={{
            background: '#111827',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
          }}
        />
        <MiniMap
          style={{
            background: '#111827',
            border: '1px solid rgba(255,255,255,0.08)',
            borderRadius: 8,
            width: minimapDims.w,
            height: minimapDims.h,
          }}
          nodeColor={(node) => {
            if (node.type === 'boo') return '#E94560'
            // Skill / resource nodes inherit visibility from their parent
            // Boo via `data.isVisible` (set by the visibleNodes memo).
            // When the parent is collapsed, return 'transparent' so the
            // MiniMap matches what the user sees in the main canvas.
            // The `?? true` default keeps MiniMap behaviour correct in
            // contexts that don't set the flag (e.g. MiniGraph) — but
            // this MiniMap is only on the Ghost Graph anyway.
            const isVisible = (node.data as { isVisible?: boolean }).isVisible ?? true
            if (node.type === 'skill') return isVisible ? '#34D399' : 'transparent'
            if (node.type === 'resource') return isVisible ? '#FBBF24' : 'transparent'
            return '#FBBF24'
          }}
          nodeComponent={GhostGraphMiniMapNode}
          maskColor="rgba(10,14,26,0.75)"
        />
      </ReactFlow>

      {/* Context menu */}
      {contextMenu && (
        <GraphContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          agentId={contextMenu.agentId}
          agentName={contextMenu.agentName}
          onClose={() => setContextMenu(null)}
          onChat={() => {
            useFleetStore.getState().selectAgent(contextMenu.agentId)
            useViewStore.getState().openAgent(contextMenu.agentId)
            setContextMenu(null)
          }}
          onEditPersonality={() => {
            useFleetStore.getState().selectAgent(contextMenu.agentId)
            useViewStore.getState().openAgent(contextMenu.agentId)
            setContextMenu(null)
          }}
          onEditFiles={() => {
            useFleetStore.getState().selectAgent(contextMenu.agentId)
            useViewStore.getState().openAgent(contextMenu.agentId)
            setContextMenu(null)
          }}
          onSelectInSidebar={() => {
            // Highlight in fleet sidebar without opening the detail view
            // (preserved from the previous left-click behaviour, which
            // now toggles peacock expand instead).
            useFleetStore.getState().selectAgent(contextMenu.agentId)
            setContextMenu(null)
          }}
          onDelete={() => {
            const client = useConnectionStore.getState().client
            if (!client) return
            const agent = useFleetStore.getState().agents.find((a) => a.id === contextMenu.agentId)
            try {
              void deleteAgentOperation(contextMenu.agentId, agent?.sessionKey ?? null, client)
            } catch {
              // handled inside deleteAgentOperation
            }
            setContextMenu(null)
          }}
        />
      )}

      {/* Edge explain panel */}
      <AnimatePresence>
        {selectedEdge && (
          <EdgeExplainPanel
            edge={selectedEdge}
            onClose={() => setSelectedEdgeId(null)}
            onDelete={selectedEdge.type === 'dependency' ? handleDeleteEdge : null}
          />
        )}
      </AnimatePresence>
    </div>
  )
}

// ─── EdgeExplainPanel ─────────────────────────────────────────────────────────

const EDGE_META = {
  skill: {
    label: 'Skill Connection',
    color: '#34D399',
    desc: 'This agent has access to this tool.',
    file: 'TOOLS.md',
  },
  dependency: {
    label: 'Agent Dependency',
    color: '#E94560',
    desc: 'This agent routes work to the target agent.',
    file: 'AGENTS.md',
  },
  resource: {
    label: 'Resource Connection',
    color: '#FBBF24',
    desc: 'This agent uses this external service.',
    file: 'TOOLS.md',
  },
} as const

function EdgeExplainPanel({
  edge,
  onClose,
  onDelete,
}: {
  edge: GraphEdge
  onClose: () => void
  onDelete: ((edgeId: string) => void) | null
}) {
  const agentFiles = useGraphStore((s) => s.agentFiles)
  const agents = useFleetStore((s) => s.agents)

  const edgeType = (edge.type ?? 'skill') as keyof typeof EDGE_META
  const meta = EDGE_META[edgeType] ?? EDGE_META.skill

  const sourceAgentId = edge.source.startsWith('boo-') ? edge.source.slice(4) : null
  const sourceAgent = sourceAgentId ? agents.find((a) => a.id === sourceAgentId) : null
  const files = sourceAgentId ? agentFiles.get(sourceAgentId) : null
  const fileContent = edgeType === 'dependency' ? files?.agentsMd : files?.toolsMd
  const excerpt = fileContent
    ? fileContent
        .split('\n')
        .find((l) => l.trim() && !l.startsWith('#'))
        ?.trim()
    : null

  return (
    <motion.div
      initial={{ y: 48, opacity: 0 }}
      animate={{ y: 0, opacity: 1 }}
      exit={{ y: 48, opacity: 0 }}
      transition={{ type: 'spring', stiffness: 320, damping: 28 }}
      style={{
        position: 'absolute',
        bottom: 16,
        left: '50%',
        transform: 'translateX(-50%)',
        width: 340,
        background: '#111827',
        border: `1px solid ${meta.color}40`,
        borderRadius: 12,
        padding: '14px 16px',
        zIndex: 10,
        boxShadow: `0 8px 32px rgba(0,0,0,0.5), 0 0 0 0.5px ${meta.color}30`,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 8,
        }}
      >
        <span style={{ fontSize: 12, fontWeight: 600, color: meta.color }}>{meta.label}</span>
        <button
          onClick={onClose}
          style={{
            background: 'none',
            border: 'none',
            color: 'rgba(232,232,232,0.4)',
            cursor: 'pointer',
            fontSize: 14,
            lineHeight: 1,
            padding: 0,
          }}
        >
          ✕
        </button>
      </div>
      <p style={{ fontSize: 12, color: 'rgba(232,232,232,0.55)', margin: '0 0 8px' }}>
        {meta.desc}
      </p>
      {sourceAgent && (
        <div
          style={{
            background: 'rgba(255,255,255,0.04)',
            borderRadius: 6,
            padding: '6px 10px',
            fontSize: 12,
          }}
        >
          <span style={{ color: 'rgba(232,232,232,0.4)' }}>Source: </span>
          <span style={{ color: '#E8E8E8', fontWeight: 500 }}>{sourceAgent.name}</span>
          <span style={{ color: 'rgba(232,232,232,0.4)' }}> · via {meta.file}</span>
        </div>
      )}
      {excerpt && (
        <p
          style={{
            fontSize: 11,
            color: 'rgba(232,232,232,0.3)',
            marginTop: 8,
            marginBottom: 0,
            overflow: 'hidden',
            whiteSpace: 'nowrap',
            textOverflow: 'ellipsis',
          }}
        >
          {excerpt}
        </p>
      )}
      {onDelete && (
        <button
          onClick={() => onDelete(edge.id)}
          style={{
            marginTop: 10,
            width: '100%',
            padding: '7px 0',
            border: '1px solid rgba(233,69,96,0.3)',
            borderRadius: 6,
            background: 'rgba(233,69,96,0.08)',
            color: '#E94560',
            fontSize: 12,
            fontWeight: 600,
            cursor: 'pointer',
            transition: 'background 0.15s',
          }}
          onMouseOver={(e) => {
            e.currentTarget.style.background = 'rgba(233,69,96,0.18)'
          }}
          onMouseOut={(e) => {
            e.currentTarget.style.background = 'rgba(233,69,96,0.08)'
          }}
        >
          Remove Connection
        </button>
      )}
    </motion.div>
  )
}
