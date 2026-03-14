import '@xyflow/react/dist/style.css'

import { useCallback, useEffect, useRef, useState } from 'react'
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
} from '@xyflow/react'
import { motion, AnimatePresence } from 'framer-motion'
import { GitBranch } from 'lucide-react'
import { useGraphStore } from './store'
import { useGraphData } from './useGraphData'
import { useGraphPersistence } from './useGraphPersistence'
import { computeElkLayout } from './useGraphLayout'
import { computeOrbitalPositions } from './computeOrbitalPositions'
import { nodeTypes } from './nodes/nodeTypes'
import { edgeTypes } from './edges/edgeTypes'
import { ConnectionLine } from './edges/ConnectionLine'
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
import type { BooNodeData, SkillNodeData, GraphEdge } from './types'

interface ContextMenuState {
  x: number
  y: number
  agentId: string
  agentName: string
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
    setHasRunLayout,
    updateNodePosition,
    connectMode,
    setConnectMode,
    setHoveredNodeId,
  } = useGraphStore()

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const nodesInitialized = useNodesInitialized()
  const { fitView } = useReactFlow()

  // Track layout state in refs to avoid stale closure issues
  const layoutRanRef = useRef(false)
  const prevNodeLengthRef = useRef(0)
  const elkGenerationRef = useRef(0)

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

  // ── Two-layer auto-layout ────────────────────────────────────────────────────
  // Layer 1: ELK positions boo nodes using dependency edges only (async).
  // Layer 2: Orbital positions skill/resource nodes around their parent boo (sync).
  // Re-runs when node count changes or user clicks "Re-layout" (layoutKey bump).
  useEffect(() => {
    if (!nodesInitialized || nodes.length === 0 || !isLoaded) return

    // Reset when node count changes (new agents added) or layoutKey bumps
    if (nodes.length !== prevNodeLengthRef.current) {
      prevNodeLengthRef.current = nodes.length
      layoutRanRef.current = false
    }

    if (layoutRanRef.current) return
    layoutRanRef.current = true

    // Increment generation only when actually starting ELK computation.
    // Previously this was at the TOP of the effect (before guard checks),
    // which meant re-renders from triggerRefresh() would invalidate
    // in-flight ELK even when node identity was unchanged.
    const generation = ++elkGenerationRef.current

    // Layer 1: Only boo nodes + dependency edges go through ELK
    const booNodes = nodes.filter((n) => n.type === 'boo')
    const nonBooNodes = nodes.filter((n) => n.type !== 'boo')
    const depEdges = edges.filter((e) => e.type === 'dependency')

    void computeElkLayout(booNodes, depEdges, savedPositions).then((layoutedBooNodes) => {
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
        void fitView({ padding: 0.15, duration: 500 })
      })
    })
    // isLoaded gates layout until saved positions are fetched from SQLite.
  }, [nodesInitialized, nodes.length, layoutKey, isLoaded])

  // Reset layout refs when layoutKey bumps (user pressed "Re-layout")
  useEffect(() => {
    layoutRanRef.current = false
    prevNodeLengthRef.current = 0
  }, [layoutKey])

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

  const onNodeClick: NodeMouseHandler<Node> = useCallback((_event, node) => {
    if (node.type === 'boo') {
      const data = node.data as BooNodeData
      useFleetStore.getState().selectAgent(data.agentId)
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

  const hasRunLayout = useGraphStore((s) => s.hasRunLayout)

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        // Hide nodes until ELK has positioned them — prevents (0,0) pile-up flash on new teams
        opacity: hasRunLayout ? 1 : 0,
        transition: 'opacity 0.25s ease',
      }}
    >
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
        nodes={nodes}
        edges={edges}
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
        style={{ background: '#0A0E1A' }}
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
          }}
          nodeColor={(node) => {
            if (node.type === 'boo') return '#E94560'
            if (node.type === 'skill') return '#34D399'
            return '#FBBF24'
          }}
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
