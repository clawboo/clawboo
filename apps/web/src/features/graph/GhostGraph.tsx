'use client'

import '@xyflow/react/dist/style.css'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  ConnectionLineType,
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
import { useGraphStore } from './store'
import { useGraphData } from './useGraphData'
import { useGraphPersistence } from './useGraphPersistence'
import { computeElkLayout } from './useGraphLayout'
import { nodeTypes } from './nodes/nodeTypes'
import { edgeTypes } from './edges/edgeTypes'
import { useFleetStore } from '@/stores/fleet'
import { useViewStore } from '@/stores/view'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { deleteAgentOperation } from '@/features/fleet/deleteAgentOperation'
import { GraphContextMenu } from './GraphContextMenu'
import type { BooNodeData, GraphEdge } from './types'

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
  } = useGraphStore()

  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null)

  const nodesInitialized = useNodesInitialized()
  const { fitView } = useReactFlow()

  // Track layout state in refs to avoid stale closure issues
  const layoutRanRef = useRef(false)
  const prevNodeLengthRef = useRef(0)

  // Wire data fetching and persistence
  useGraphData()
  const { savePositions } = useGraphPersistence()

  // ── ELK auto-layout ──────────────────────────────────────────────────────────
  // Runs once after ReactFlow measures node dimensions; re-runs when node count
  // changes or when the user clicks "Re-layout" (layoutKey bump).
  useEffect(() => {
    if (!nodesInitialized || nodes.length === 0) return

    // Reset when node count changes (new agents added) or layoutKey bumps
    if (nodes.length !== prevNodeLengthRef.current) {
      prevNodeLengthRef.current = nodes.length
      layoutRanRef.current = false
    }

    if (layoutRanRef.current) return
    layoutRanRef.current = true

    void computeElkLayout(nodes, edges, savedPositions).then((layoutedNodes) => {
      setNodes(layoutedNodes)
      setHasRunLayout(true)
      requestAnimationFrame(() => {
        void fitView({ padding: 0.15, duration: 500 })
      })
    })
    // Intentionally scoped to these three deps; refs guard re-entry.
  }, [nodesInitialized, nodes.length, layoutKey])

  // Reset layout refs when layoutKey bumps (user pressed "Re-layout")
  useEffect(() => {
    layoutRanRef.current = false
    prevNodeLengthRef.current = 0
  }, [layoutKey])

  // ── Interaction handlers ─────────────────────────────────────────────────────

  const onNodeDragStop: OnNodeDrag<Node> = useCallback(
    (_event, node) => {
      updateNodePosition(node.id, node.position)
      const currentSaved = useGraphStore.getState().savedPositions
      savePositions({ ...currentSaved, [node.id]: node.position })
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

  const onConnect = useCallback(
    async (connection: Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source)
      const targetNode = nodes.find((n) => n.id === connection.target)
      if (!sourceNode || !targetNode) return
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
        target: connection.target,
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
        // TODO: wrap in mutationQueue.enqueue() after Step 11
        await client.agents.files.set(sourceAgentId, 'AGENTS.md', newAgentsMd)

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
      return source?.type === 'boo' && target?.type === 'boo' && source.id !== target.id
    },
    [nodes],
  )

  const onPaneClick = useCallback(() => {
    setSelectedEdgeId(null)
    setContextMenu(null)
  }, [setSelectedEdgeId])

  // ── Derive selected edge for explain panel ───────────────────────────────────
  const selectedEdge = selectedEdgeId ? (edges.find((e) => e.id === selectedEdgeId) ?? null) : null

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onEdgeClick={onEdgeClick}
        onNodeClick={onNodeClick}
        onNodeContextMenu={onNodeContextMenu}
        onPaneClick={onPaneClick}
        onConnect={onConnect}
        isValidConnection={isValidConnection}
        connectOnClick={false}
        connectionLineStyle={{ stroke: '#E94560', strokeWidth: 2, strokeDasharray: '6 4' }}
        connectionLineType={ConnectionLineType.SmoothStep}
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
          gap={22}
          size={1}
          color="rgba(255,255,255,0.04)"
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
            useViewStore.getState().setView('chat')
            setContextMenu(null)
          }}
          onEditPersonality={() => {
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
          <EdgeExplainPanel edge={selectedEdge} onClose={() => setSelectedEdgeId(null)} />
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

function EdgeExplainPanel({ edge, onClose }: { edge: GraphEdge; onClose: () => void }) {
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
    </motion.div>
  )
}
