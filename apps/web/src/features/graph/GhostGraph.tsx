'use client'

import '@xyflow/react/dist/style.css'

import { useCallback, useEffect, useRef } from 'react'
import {
  ReactFlow,
  Background,
  Controls,
  MiniMap,
  BackgroundVariant,
  useNodesInitialized,
  useReactFlow,
} from '@xyflow/react'
import type { NodeMouseHandler, EdgeMouseHandler, OnNodeDrag, Node } from '@xyflow/react'
import { motion, AnimatePresence } from 'framer-motion'
import { useGraphStore } from './store'
import { useGraphData } from './useGraphData'
import { useGraphPersistence } from './useGraphPersistence'
import { computeElkLayout } from './useGraphLayout'
import { nodeTypes } from './nodes/nodeTypes'
import { edgeTypes } from './edges/edgeTypes'
import { useFleetStore } from '@/stores/fleet'
import type { BooNodeData, GraphEdge } from './types'

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

  const onPaneClick = useCallback(() => {
    setSelectedEdgeId(null)
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
        onPaneClick={onPaneClick}
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
