import '@xyflow/react/dist/style.css'

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  ReactFlow,
  ReactFlowProvider,
  Background,
  BackgroundVariant,
  useReactFlow,
  useNodesInitialized,
  applyNodeChanges,
  applyEdgeChanges,
} from '@xyflow/react'
import type {
  NodeMouseHandler,
  OnNodeDrag,
  Node,
  Connection,
  IsValidConnection,
  NodeChange,
  EdgeChange,
} from '@xyflow/react'
import { nodeTypes } from '@/features/graph/nodes/nodeTypes'
import { edgeTypes } from '@/features/graph/edges/edgeTypes'
import { ConnectionLine } from '@/features/graph/edges/ConnectionLine'
import { computeOrbitalPositions } from '@/features/graph/computeOrbitalPositions'
import { installSkillForAgent } from '@/features/graph/operations/installSkill'
import { useFleetStore } from '@/stores/fleet'
import { useConnectionStore } from '@/stores/connection'
import { useToastStore } from '@/stores/toast'
import { AgentModelSelector } from './AgentModelSelector'
import { useMiniGraphData } from './useMiniGraphData'
import type { GraphNode, GraphEdge, BooNodeData, SkillNodeData } from '@/features/graph/types'

// ─── Constants ───────────────────────────────────────────────────────────────

const BOO_CENTER = { x: 200, y: 100 }
// Offset from each Boo's React Flow `node.position` (top-left of the
// envelope) to its visual center. The Boo renders centered inside its
// envelope (BOO_FOOTPRINT = 340 in `nodes/BooNode.tsx`), so the center is
// at half the envelope size — same anchor used by `computeOrbitalPositions`,
// the global `graphPhysics` singleton, and `TeamHaloLayer`. Without this,
// the local physics engine would compute Boo center 80px left + 130px above
// the actual visual center, slowly drifting orbital children off their
// layout positions during drag interactions.
const BOO_HALF_W = 170
const BOO_HALF_H = 170

// Physics constants (simplified from graphPhysics.ts — local per mini graph)
const SPRING_STRENGTH = 0.035
const REPULSION_CONSTANT = 2000
const MIN_COLLISION_DISTANCE_SQ = 60 * 60
const DAMPING = 0.88
const SETTLE_THRESHOLD = 0.02
const MAX_VELOCITY = 12
const POSITION_EPSILON = 0.5
const FRAME_CAP_MS = 16

const SKILL_HALF = 19
const RESOURCE_HALF_W = 32
const RESOURCE_HALF_H = 35

// ─── Local physics particle ──────────────────────────────────────────────────

interface Particle {
  id: string
  x: number
  y: number
  vx: number
  vy: number
  parentBooId: string
  restRadius: number
  halfW: number
  halfH: number
  pinned: boolean
  kind: 'boo' | 'skill' | 'resource'
}

// ─── MiniGraph (inner — must be inside ReactFlowProvider) ────────────────────

function MiniGraphInner({ agentId }: { agentId: string }) {
  const { nodes: rawNodes, edges: rawEdges, isLoading } = useMiniGraphData(agentId)
  const { fitView } = useReactFlow()
  const nodesInitialized = useNodesInitialized()

  // Local ReactFlow state
  const [nodes, setNodes] = useState<GraphNode[]>([])
  const [edges, setEdges] = useState<GraphEdge[]>([])

  // Hover cascade state
  const [hoveredNodeId, setHoveredNodeId] = useState<string | null>(null)
  const [highlightedNodeIds, setHighlightedNodeIds] = useState<Set<string> | null>(null)
  const [highlightedEdgeIds, setHighlightedEdgeIds] = useState<Set<string> | null>(null)

  // Physics state
  const particlesRef = useRef<Particle[]>([])
  const particleMapRef = useRef<Map<string, Particle>>(new Map())
  const physicsActiveRef = useRef(false)
  const rafIdRef = useRef<number | null>(null)
  const lastFrameTimeRef = useRef(0)
  const layoutDoneRef = useRef(false)
  const prevRawKeyRef = useRef('')

  // ── Handle hover cascade ──────────────────────────────────────────────────

  const handleSetHoveredNodeId = useCallback(
    (id: string | null) => {
      if (id === null) {
        setHoveredNodeId(null)
        setHighlightedNodeIds(null)
        setHighlightedEdgeIds(null)
        return
      }
      const connectedNodes = new Set<string>([id])
      const connectedEdges = new Set<string>()
      for (const edge of edges) {
        if (edge.source === id || edge.target === id) {
          connectedNodes.add(edge.source)
          connectedNodes.add(edge.target)
          connectedEdges.add(edge.id)
        }
      }
      setHoveredNodeId(id)
      setHighlightedNodeIds(connectedNodes)
      setHighlightedEdgeIds(connectedEdges)
    },
    [edges],
  )

  // ── Inject hover data into nodes ──────────────────────────────────────────

  const nodesWithHover = useMemo(() => {
    return nodes.map((node) => ({
      ...node,
      data: {
        ...node.data,
        _miniHovered: hoveredNodeId,
        _miniHighlightedNodes: highlightedNodeIds,
        _miniHighlightedEdges: highlightedEdgeIds,
      },
    }))
  }, [nodes, hoveredNodeId, highlightedNodeIds, highlightedEdgeIds]) as GraphNode[]

  const edgesWithHover = useMemo(() => {
    if (hoveredNodeId === null) return edges
    return edges.map((edge) => ({
      ...edge,
      style: {
        ...(edge.style ?? {}),
        opacity: highlightedEdgeIds?.has(edge.id) ? 1 : 0.12,
        transition: 'opacity 0.2s ease',
      },
    }))
  }, [edges, hoveredNodeId, highlightedEdgeIds])

  // ── Physics engine (local, per-mini-graph instance) ───────────────────────

  const initializePhysics = useCallback((layoutNodes: GraphNode[], layoutEdges: GraphEdge[]) => {
    const particles: Particle[] = []
    const pMap = new Map<string, Particle>()

    // Build parent map
    const parentMap = new Map<string, string>()
    for (const edge of layoutEdges) {
      if (edge.type === 'skill' || edge.type === 'resource') {
        parentMap.set(edge.target, edge.source)
      }
    }

    // Boo centers
    const booCenters = new Map<string, { cx: number; cy: number }>()
    for (const node of layoutNodes) {
      if (node.type === 'boo') {
        booCenters.set(node.id, {
          cx: node.position.x + BOO_HALF_W,
          cy: node.position.y + BOO_HALF_H,
        })
      }
    }

    // Create Boo particles (needed so skills can read Boo position during drag)
    for (const node of layoutNodes) {
      if (node.type !== 'boo') continue
      const particle: Particle = {
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        vx: 0,
        vy: 0,
        parentBooId: '',
        restRadius: 0,
        halfW: BOO_HALF_W,
        halfH: BOO_HALF_H,
        pinned: false,
        kind: 'boo',
      }
      particles.push(particle)
      pMap.set(node.id, particle)
    }

    // Create particles for skill/resource nodes
    for (const node of layoutNodes) {
      if (node.type !== 'skill' && node.type !== 'resource') continue
      const parentBooId = parentMap.get(node.id)
      if (!parentBooId) continue
      const parentCenter = booCenters.get(parentBooId)
      if (!parentCenter) continue

      const halfW = node.type === 'skill' ? SKILL_HALF : RESOURCE_HALF_W
      const halfH = node.type === 'skill' ? SKILL_HALF : RESOURCE_HALF_H
      const pcx = node.position.x + halfW
      const pcy = node.position.y + halfH
      const dx = pcx - parentCenter.cx
      const dy = pcy - parentCenter.cy

      const particle: Particle = {
        id: node.id,
        x: node.position.x,
        y: node.position.y,
        vx: 0,
        vy: 0,
        parentBooId,
        restRadius: Math.max(Math.sqrt(dx * dx + dy * dy), 1),
        halfW,
        halfH,
        pinned: false,
        kind: node.type === 'skill' ? 'skill' : 'resource',
      }
      particles.push(particle)
      pMap.set(node.id, particle)
    }

    particlesRef.current = particles
    particleMapRef.current = pMap
  }, [])

  const stopPhysics = useCallback(() => {
    physicsActiveRef.current = false
    if (rafIdRef.current !== null) {
      cancelAnimationFrame(rafIdRef.current)
      rafIdRef.current = null
    }
  }, [])

  const stepPhysics = useCallback(() => {
    const particles = particlesRef.current
    if (particles.length === 0) {
      stopPhysics()
      return
    }

    // NOTE: Pinned particle positions are set directly by onNodeDrag (every frame).
    // We do NOT read from nodesRef/React state — particles are the source of truth.

    // Build Boo position map from particles (not React state — avoids lag)
    const booPositions = new Map<string, { cx: number; cy: number }>()
    for (const p of particles) {
      if (p.kind === 'boo') {
        booPositions.set(p.id, { cx: p.x + BOO_HALF_W, cy: p.y + BOO_HALF_H })
      }
    }

    let totalKE = 0
    let nonBooCount = 0
    let anyPinned = false

    for (let i = 0; i < particles.length; i++) {
      const p = particles[i]!
      if (p.pinned) {
        anyPinned = true
        continue
      }
      // Boo particles don't need forces in single-boo mini graph
      if (p.kind === 'boo') continue

      nonBooCount++
      let fx = 0
      let fy = 0
      const pcx = p.x + p.halfW
      const pcy = p.y + p.halfH

      // Spring toward parent Boo center
      const parent = booPositions.get(p.parentBooId)
      if (parent) {
        const dx = parent.cx - pcx
        const dy = parent.cy - pcy
        const dist = Math.sqrt(dx * dx + dy * dy)
        if (dist > 0) {
          const displacement = dist - p.restRadius
          const springForce = SPRING_STRENGTH * displacement
          fx += (dx / dist) * springForce
          fy += (dy / dist) * springForce
        }
      }

      // Sibling repulsion (same parent only)
      for (let j = 0; j < particles.length; j++) {
        if (i === j) continue
        const q = particles[j]!
        if (q.kind === 'boo') continue
        if (p.parentBooId !== q.parentBooId) continue
        let sdx = pcx - (q.x + q.halfW)
        let sdy = pcy - (q.y + q.halfH)
        let distSq = sdx * sdx + sdy * sdy

        if (distSq < 1) {
          sdx = (i > j ? 1 : -1) * 0.5
          sdy = (i % 2 === 0 ? 1 : -1) * 0.5
          distSq = sdx * sdx + sdy * sdy
        }

        if (distSq < MIN_COLLISION_DISTANCE_SQ) {
          const d = Math.sqrt(distSq)
          const repForce = REPULSION_CONSTANT / distSq
          fx += (sdx / d) * repForce
          fy += (sdy / d) * repForce
        }
      }

      p.vx = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, (p.vx + fx) * DAMPING))
      p.vy = Math.max(-MAX_VELOCITY, Math.min(MAX_VELOCITY, (p.vy + fy) * DAMPING))
      p.x += p.vx
      p.y += p.vy
      totalKE += p.vx * p.vx + p.vy * p.vy
    }

    // Settle check — only count non-boo particles, never settle while dragging
    if (!anyPinned) {
      const avgKE = nonBooCount > 0 ? totalKE / nonBooCount : 0
      if (avgKE < SETTLE_THRESHOLD) {
        stopPhysics()
      }
    }

    // Write particle positions to React Flow nodes via functional update
    // (functional form avoids overwriting React Flow's concurrent drag position updates)
    setNodes((prev) => {
      let anyChanged = false
      const next = prev.map((node) => {
        const p = particleMapRef.current.get(node.id)
        if (!p || p.pinned) return node
        if (p.kind === 'boo') return node // Boo position managed by React Flow drag
        const ddx = Math.abs(node.position.x - p.x)
        const ddy = Math.abs(node.position.y - p.y)
        if (ddx < POSITION_EPSILON && ddy < POSITION_EPSILON) return node
        anyChanged = true
        return { ...node, position: { x: p.x, y: p.y } }
      })
      return anyChanged ? (next as GraphNode[]) : prev
    })
  }, [stopPhysics])

  const startPhysics = useCallback(() => {
    if (physicsActiveRef.current) return
    physicsActiveRef.current = true
    lastFrameTimeRef.current = 0

    const tick = (now: number) => {
      if (!physicsActiveRef.current) {
        rafIdRef.current = null
        return
      }
      if (now - lastFrameTimeRef.current >= FRAME_CAP_MS) {
        lastFrameTimeRef.current = now
        stepPhysics()
      }
      if (physicsActiveRef.current) {
        rafIdRef.current = requestAnimationFrame(tick)
      } else {
        rafIdRef.current = null
      }
    }
    rafIdRef.current = requestAnimationFrame(tick)
  }, [stepPhysics])

  // Cleanup on unmount
  useEffect(() => {
    return () => stopPhysics()
  }, [stopPhysics])

  // ── Layout: place Boo at center, orbit children ───────────────────────────

  useEffect(() => {
    if (rawNodes.length === 0) {
      setNodes([])
      setEdges([])
      layoutDoneRef.current = false
      return
    }

    // Dedupe: only re-layout if the node STRUCTURE changed (different IDs).
    // For pure data changes (e.g. agent.status flipping idle ↔ running, which
    // drives BooNode's dual-shape morph), keep existing positions and patch
    // only the data field. Without this, the BooNode in MiniGraph would
    // never see the new status and never morph from circle to card.
    const rawKey = rawNodes.map((n) => n.id).join('|')
    if (rawKey === prevRawKeyRef.current && layoutDoneRef.current) {
      const rawById = new Map(rawNodes.map((n) => [n.id, n]))
      setNodes((existing) =>
        existing.map((n) => {
          const fresh = rawById.get(n.id)
          if (!fresh) return n
          // Keep position (from layout), update data (status / isStreaming / etc.)
          return { ...n, data: fresh.data } as GraphNode
        }),
      )
      return
    }
    prevRawKeyRef.current = rawKey

    const booNodes = rawNodes.filter((n) => n.type === 'boo')
    const nonBooNodes = rawNodes.filter((n) => n.type !== 'boo')

    // Place single boo at fixed center
    const layoutBoos = booNodes.map((n) => ({
      ...n,
      position: { ...BOO_CENTER },
    }))

    // Orbital positions for children
    const orbitalNodes = computeOrbitalPositions(layoutBoos, nonBooNodes, rawEdges, {})

    const allNodes = [...layoutBoos, ...orbitalNodes] as GraphNode[]
    setNodes(allNodes)
    setEdges(rawEdges)
    layoutDoneRef.current = true

    // Initialize physics after layout
    requestAnimationFrame(() => {
      initializePhysics(allNodes, rawEdges)
      startPhysics()
    })
  }, [rawNodes, rawEdges, initializePhysics, startPhysics])

  // Fit view after initial layout
  useEffect(() => {
    if (nodesInitialized && nodes.length > 0) {
      requestAnimationFrame(() => {
        void fitView({ padding: 0.3, duration: 300 })
      })
    }
  }, [nodesInitialized, nodes.length > 0])

  // ── Interaction handlers ──────────────────────────────────────────────────

  const onNodesChange = useCallback((changes: NodeChange<GraphNode>[]) => {
    setNodes((nds) => applyNodeChanges(changes, nds) as GraphNode[])
  }, [])

  const onEdgesChange = useCallback((changes: EdgeChange<GraphEdge>[]) => {
    setEdges((eds) => applyEdgeChanges(changes, eds) as GraphEdge[])
  }, [])

  const onNodeDragStart: OnNodeDrag<Node> = useCallback(
    (_event, node) => {
      const p = particleMapRef.current.get(node.id)
      if (p) {
        p.pinned = true
        p.x = node.position.x
        p.y = node.position.y
      }
      // Start physics immediately so skills follow the Boo during drag
      startPhysics()
    },
    [startPhysics],
  )

  const onNodeDrag: OnNodeDrag<Node> = useCallback((_event, node) => {
    // Continuously sync dragged node position into its particle
    const p = particleMapRef.current.get(node.id)
    if (p) {
      p.x = node.position.x
      p.y = node.position.y
    }
  }, [])

  const onNodeDragStop: OnNodeDrag<Node> = useCallback(
    (_event, node) => {
      const p = particleMapRef.current.get(node.id)
      if (p) {
        p.pinned = false
        p.x = node.position.x
        p.y = node.position.y
        p.vx = 0
        p.vy = 0
      }
      startPhysics()
    },
    [startPhysics],
  )

  const onNodeMouseEnter: NodeMouseHandler<Node> = useCallback(
    (_event, node) => {
      handleSetHoveredNodeId(node.id)
    },
    [handleSetHoveredNodeId],
  )

  const onNodeMouseLeave: NodeMouseHandler<Node> = useCallback(() => {
    handleSetHoveredNodeId(null)
  }, [handleSetHoveredNodeId])

  const onConnect = useCallback(
    async (connection: Connection) => {
      const sourceNode = nodes.find((n) => n.id === connection.source)
      const targetNode = nodes.find((n) => n.id === connection.target)
      if (!sourceNode || !targetNode) return

      // Skill-to-Boo install
      if (sourceNode.type === 'skill' && targetNode.type === 'boo') {
        const skillData = sourceNode.data as SkillNodeData
        const booData = targetNode.data as BooNodeData
        void installSkillForAgent(skillData.name, booData.agentId, booData.name)
      }
    },
    [nodes],
  )

  const isValidConnection: IsValidConnection = useCallback(
    (connection) => {
      const source = nodes.find((n) => n.id === connection.source)
      const target = nodes.find((n) => n.id === connection.target)
      return source?.type === 'skill' && target?.type === 'boo'
    },
    [nodes],
  )

  const onPaneClick = useCallback(() => {
    handleSetHoveredNodeId(null)
  }, [handleSetHoveredNodeId])

  // ── Render ────────────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0A0E1A',
          color: 'rgba(232,232,232,0.4)',
          fontSize: 12,
        }}
      >
        Loading graph…
      </div>
    )
  }

  if (nodes.length === 0) {
    return (
      <div
        style={{
          width: '100%',
          height: '100%',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#0A0E1A',
          color: 'rgba(232,232,232,0.3)',
          fontSize: 12,
        }}
      >
        No skills or resources
      </div>
    )
  }

  return (
    <ReactFlow
      nodes={nodesWithHover}
      edges={edgesWithHover}
      onNodesChange={onNodesChange}
      onEdgesChange={onEdgesChange}
      onNodeDragStart={onNodeDragStart}
      onNodeDrag={onNodeDrag}
      onNodeDragStop={onNodeDragStop}
      onNodeMouseEnter={onNodeMouseEnter}
      onNodeMouseLeave={onNodeMouseLeave}
      onPaneClick={onPaneClick}
      onConnect={onConnect}
      isValidConnection={isValidConnection}
      connectionLineComponent={ConnectionLine}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      proOptions={{ hideAttribution: true }}
      style={{ background: '#0A0E1A' }}
      minZoom={0.3}
      maxZoom={2}
      defaultEdgeOptions={{ animated: false }}
    >
      <Background
        variant={BackgroundVariant.Dots}
        gap={32}
        size={1}
        color="rgba(255,255,255,0.03)"
      />
    </ReactFlow>
  )
}

// ─── MiniGraph (outer — provides ReactFlowProvider + model selector overlay) ─

export function MiniGraph({ agentId }: { agentId: string }) {
  const agent = useFleetStore((s) => s.agents.find((a) => a.id === agentId) ?? null)
  const client = useConnectionStore((s) => s.client)
  const addToast = useToastStore((s) => s.addToast)

  // ── Default model (fetched once) ──────────────────────────────────────────
  const [defaultModel, setDefaultModel] = useState<string | null>(null)

  useEffect(() => {
    fetch('/api/system/openclaw-config')
      .then((r) => r.json())
      .then((data: { config?: { agents?: { defaults?: { model?: { primary?: string } } } } }) => {
        setDefaultModel(data?.config?.agents?.defaults?.model?.primary ?? null)
      })
      .catch(() => {})
  }, [])

  const handleModelChange = useCallback(
    async (model: string | null) => {
      if (!agent) return
      // Update fleet store immediately
      useFleetStore.getState().updateAgentModel(agent.id, model)
      // Persist to openclaw.json
      try {
        await fetch('/api/system/openclaw-config', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ agentModel: { agentId: agent.id, model } }),
        })
      } catch {
        addToast({ message: 'Failed to save model preference', type: 'error' })
      }
      // Apply to active session immediately
      const sessionKey = agent.sessionKey ?? null
      if (client && sessionKey && model) {
        try {
          await client.call('sessions.patch', { key: sessionKey, model })
        } catch {
          // Non-fatal: model will be applied on next chat.send
        }
      }
    },
    [agent, client, addToast],
  )

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      <ReactFlowProvider>
        <MiniGraphInner agentId={agentId} />
      </ReactFlowProvider>

      {/* Model selector — floating overlay, top-right */}
      {agent && (
        <div
          style={{
            position: 'absolute',
            top: 8,
            right: 8,
            zIndex: 10,
          }}
        >
          <AgentModelSelector
            currentModel={agent.model ?? null}
            defaultModel={defaultModel}
            onModelChange={handleModelChange}
          />
        </div>
      )}
    </div>
  )
}
