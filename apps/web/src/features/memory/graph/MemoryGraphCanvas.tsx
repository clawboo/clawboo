import '@xyflow/react/dist/style.css'

import { useCallback, useEffect, useRef, useState } from 'react'
import {
  applyEdgeChanges,
  applyNodeChanges,
  Background,
  BackgroundVariant,
  MiniMap,
  ReactFlow,
  useReactFlow,
} from '@xyflow/react'
import type { EdgeChange, NodeChange, NodeMouseHandler, OnNodeDrag } from '@xyflow/react'
import { memoryEdgeTypes } from './edges/edgeTypes'
import { MemoryHullLayer } from './MemoryHullLayer'
import { computeMemoryLayout, type LayoutPositions } from './memoryGraphLayout'
import { memoryNodeTypes } from './nodes/nodeTypes'
import { useMemoryGraphStore } from './store'
import { buildMemoryFlowElements, useMemoryGraphData } from './useMemoryGraphData'
import { communityColor, type MemFlowEdge, type MemFlowNode, type MemNodeData } from './types'

// ─── MemoryGraphCanvas — the React Flow surface ──────────────────────────────
//
// Must render inside <ReactFlowProvider> (done by MemoryGraphView). RF
// nodes/edges are LOCAL state (the MiniGraph pattern) — the zustand store
// holds domain state, never RF arrays. Layout (async ELK stress → deterministic
// fallback) runs only when payloadVersion bumps; community/scope filter flips
// rebuild the hidden flags from cached positions without re-running ELK, and
// a generation ref guards stale async results.

export function MemoryGraphCanvas() {
  useMemoryGraphData()

  const payload = useMemoryGraphStore((s) => s.payload)
  const payloadVersion = useMemoryGraphStore((s) => s.payloadVersion)
  const hiddenCommunities = useMemoryGraphStore((s) => s.hiddenCommunities)
  const scopeFilter = useMemoryGraphStore((s) => s.scopeFilter)
  const locked = useMemoryGraphStore((s) => s.locked)
  const showMinimap = useMemoryGraphStore((s) => s.showMinimap)
  const showHulls = useMemoryGraphStore((s) => s.showHulls)

  const { fitView } = useReactFlow()

  const [nodes, setNodes] = useState<MemFlowNode[]>([])
  const [edges, setEdges] = useState<MemFlowEdge[]>([])
  const [hasLaidOut, setHasLaidOut] = useState(false)

  const positionsRef = useRef<LayoutPositions>(new Map())
  const layoutGenRef = useRef(0)
  const laidOutVersionRef = useRef(0)

  useEffect(() => {
    if (!payload) {
      setNodes([])
      setEdges([])
      return
    }
    const built = buildMemoryFlowElements(payload, { hiddenCommunities, scopeFilter })
    if (laidOutVersionRef.current === payloadVersion) {
      // Filter-only change (or a learning patch) — reuse cached positions so
      // the layout never shifts under a checkbox flip.
      setNodes(
        built.nodes.map((n) => ({
          ...n,
          position: positionsRef.current.get(n.id) ?? { x: 0, y: 0 },
        })),
      )
      setEdges(built.edges)
      return
    }
    const generation = ++layoutGenRef.current
    const layoutNodes = built.nodes.map((n) => ({
      id: n.id,
      width: n.width ?? 44,
      height: n.height ?? 44,
    }))
    // Similarity + tag edges only — version edges are decoration, not geometry.
    const layoutEdges = payload.edges
      .filter((e) => e.kind !== 'version')
      .map((e) => ({ id: e.id, source: e.source, target: e.target }))
    void computeMemoryLayout(layoutNodes, layoutEdges).then((positions) => {
      if (generation !== layoutGenRef.current) return // stale ELK result
      laidOutVersionRef.current = payloadVersion
      positionsRef.current = positions
      setNodes(built.nodes.map((n) => ({ ...n, position: positions.get(n.id) ?? { x: 0, y: 0 } })))
      setEdges(built.edges)
      setHasLaidOut(true)
      requestAnimationFrame(() => {
        void fitView({ padding: 0.2, duration: 500 })
      })
    })
  }, [payload, payloadVersion, hiddenCommunities, scopeFilter, fitView])

  const onNodesChange = useCallback((changes: NodeChange<MemFlowNode>[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds))
  }, [])
  const onEdgesChange = useCallback((changes: EdgeChange<MemFlowEdge>[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds))
  }, [])

  // Drag-end folds the user's position back into the cache so a later filter
  // rebuild doesn't snap the node home.
  const onNodeDragStop: OnNodeDrag<MemFlowNode> = useCallback((_e, node) => {
    positionsRef.current.set(node.id, node.position)
  }, [])

  const onNodeClick: NodeMouseHandler<MemFlowNode> = useCallback((_e, node) => {
    useMemoryGraphStore.getState().select(node.id)
  }, [])
  const onPaneClick = useCallback(() => {
    const store = useMemoryGraphStore.getState()
    store.select(null)
    store.setHovered(null)
  }, [])
  const onNodeMouseEnter: NodeMouseHandler<MemFlowNode> = useCallback((_e, node) => {
    useMemoryGraphStore.getState().setHovered(node.id)
  }, [])
  const onNodeMouseLeave = useCallback(() => {
    useMemoryGraphStore.getState().setHovered(null)
  }, [])

  return (
    <div
      data-testid="memory-graph-canvas"
      style={{
        width: '100%',
        height: '100%',
        position: 'relative',
        background: 'var(--canvas)',
        // Hide nodes until layout lands — prevents the (0,0) pile-up flash.
        opacity: hasLaidOut || nodes.length === 0 ? 1 : 0,
        transition: 'opacity 0.25s ease',
      }}
    >
      {showHulls && <MemoryHullLayer nodes={nodes} />}
      <ReactFlow
        nodes={nodes}
        edges={edges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeDragStop={onNodeDragStop}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onNodeMouseEnter={onNodeMouseEnter}
        onNodeMouseLeave={onNodeMouseLeave}
        nodeTypes={memoryNodeTypes}
        edgeTypes={memoryEdgeTypes}
        fitView
        proOptions={{ hideAttribution: true }}
        style={{ background: 'transparent' }}
        minZoom={0.15}
        maxZoom={2.5}
        defaultEdgeOptions={{ animated: false }}
        nodesDraggable={!locked}
        elementsSelectable={!locked}
      >
        <Background variant={BackgroundVariant.Dots} gap={32} size={1} color="var(--canvas-dot)" />
        {showMinimap && (
          <MiniMap
            position="bottom-right"
            style={{
              background: 'var(--canvas-control)',
              border: '1px solid var(--canvas-control-border)',
              borderRadius: 10,
              // Float above the bottom-right viewport bar (40px + 12px inset + gap).
              bottom: 60,
              right: 12,
              margin: 0,
            }}
            nodeColor={(node) => {
              const data = node.data as MemNodeData | undefined
              return data?.node ? communityColor(data.node.community) : 'var(--canvas-dot)'
            }}
            maskColor="var(--canvas-mask)"
          />
        )}
      </ReactFlow>
    </div>
  )
}
