import { useGraphStore } from './store'
import type { GraphNode, GraphEdge } from './types'

// ─── Particle ────────────────────────────────────────────────────────────────

interface Particle {
  id: string
  x: number // top-left position (React Flow convention)
  y: number
  vx: number
  vy: number
  parentBooId: string
  restRadius: number // natural spring length from initial orbital distance
  halfW: number
  halfH: number
  pinned: boolean
  kind: 'boo' | 'skill' | 'resource'
}

// ─── Constants ───────────────────────────────────────────────────────────────
// Copied from computeOrbitalPositions.ts (same decoupling pattern as useFloatingMotion.ts)

const SPRING_STRENGTH = 0.035
const REPULSION_CONSTANT = 2000
const MIN_COLLISION_DISTANCE = 60
const MIN_COLLISION_DISTANCE_SQ = MIN_COLLISION_DISTANCE * MIN_COLLISION_DISTANCE
const DAMPING = 0.88
const SETTLE_THRESHOLD = 0.02
const FRAME_CAP_MS = 16
const MAX_VELOCITY = 12
const POSITION_EPSILON = 0.5 // minimum movement to trigger store write

// Boo-Boo collision — heavy, no-bounce push
const BOO_COLLISION_DISTANCE = 180
const BOO_COLLISION_DISTANCE_SQ = BOO_COLLISION_DISTANCE * BOO_COLLISION_DISTANCE
const BOO_REPULSION_CONSTANT = 500
const BOO_DAMPING = 0.8
const BOO_MAX_VELOCITY = 3

// Offset from each Boo's React Flow `node.position` (top-left of the
// envelope) to its visual center. The Boo renders centered inside its
// envelope (BOO_FOOTPRINT = 340 in `nodes/BooNode.tsx`), so the center is
// at half the envelope size — which is what spring math + Boo-Boo
// collision detection treat as the Boo "anchor" point.
const BOO_HALF_W = 170
const BOO_HALF_H = 170

// Node half-sizes for center computation
const SKILL_HALF = 19 // 38 / 2
const RESOURCE_HALF_W = 32 // 64 / 2
const RESOURCE_HALF_H = 35 // 70 / 2

// ─── Internal state ──────────────────────────────────────────────────────────

let particles: Particle[] = []
let particleMap = new Map<string, Particle>()
let rafId: number | null = null
let lastFrameTime = 0
let active = false

// ─── RAF loop ────────────────────────────────────────────────────────────────

function startLoop(): void {
  if (active) return
  active = true
  lastFrameTime = 0
  rafId = requestAnimationFrame(tick)
}

function stopLoop(): void {
  active = false
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

function tick(now: number): void {
  if (!active) {
    rafId = null
    return
  }
  if (now - lastFrameTime >= FRAME_CAP_MS) {
    lastFrameTime = now
    stepPhysics()
  }
  if (active) {
    rafId = requestAnimationFrame(tick)
  } else {
    rafId = null
  }
}

// ─── Physics step ────────────────────────────────────────────────────────────

function stepPhysics(): void {
  if (particles.length === 0) {
    stopLoop()
    return
  }

  // 1. Read current Boo positions from store
  const storeNodes = useGraphStore.getState().nodes

  // Sync pinned Boo particles from store (user is dragging them)
  for (const p of particles) {
    if (p.kind === 'boo' && p.pinned) {
      const node = storeNodes.find((n) => n.id === p.id)
      if (node) {
        p.x = node.position.x
        p.y = node.position.y
      }
    }
  }

  // Build Boo position map — prefer physics particle over store (avoids 1-frame lag)
  const booPositions = new Map<string, { cx: number; cy: number }>()
  for (const node of storeNodes) {
    if (node.type === 'boo') {
      const bp = particleMap.get(node.id)
      if (bp && !bp.pinned) {
        booPositions.set(node.id, { cx: bp.x + BOO_HALF_W, cy: bp.y + BOO_HALF_H })
      } else {
        booPositions.set(node.id, {
          cx: node.position.x + BOO_HALF_W,
          cy: node.position.y + BOO_HALF_H,
        })
      }
    }
  }

  // 2. Compute forces and integrate
  let totalKE = 0

  for (let i = 0; i < particles.length; i++) {
    const p = particles[i]!
    if (p.pinned) continue

    let fx = 0
    let fy = 0
    const pcx = p.x + p.halfW
    const pcy = p.y + p.halfH

    // Spring force toward parent Boo center (skill/resource only)
    if (p.kind !== 'boo') {
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
    }

    // Repulsion from sibling particles (same parent Boo only — skill/resource)
    if (p.kind !== 'boo') {
      for (let j = 0; j < particles.length; j++) {
        if (i === j) continue
        const q = particles[j]!
        if (q.kind === 'boo') continue
        if (p.parentBooId !== q.parentBooId) continue
        let dx = pcx - (q.x + q.halfW)
        let dy = pcy - (q.y + q.halfH)
        let distSq = dx * dx + dy * dy

        // Handle exact overlap: apply small deterministic displacement to break symmetry
        if (distSq < 1) {
          dx = (i > j ? 1 : -1) * 0.5
          dy = (i % 2 === 0 ? 1 : -1) * 0.5
          distSq = dx * dx + dy * dy
        }

        if (distSq < MIN_COLLISION_DISTANCE_SQ) {
          const dist = Math.sqrt(distSq)
          const repForce = REPULSION_CONSTANT / distSq
          fx += (dx / dist) * repForce
          fy += (dy / dist) * repForce
        }
      }
    }

    // Boo-Boo repulsion (heavy, no-bounce push)
    if (p.kind === 'boo') {
      for (let j = 0; j < particles.length; j++) {
        if (i === j) continue
        const q = particles[j]!
        if (q.kind !== 'boo') continue

        let dx = pcx - (q.x + q.halfW)
        let dy = pcy - (q.y + q.halfH)
        let distSq = dx * dx + dy * dy

        if (distSq < 1) {
          dx = (i > j ? 1 : -1) * 0.5
          dy = (i % 2 === 0 ? 1 : -1) * 0.5
          distSq = dx * dx + dy * dy
        }

        if (distSq < BOO_COLLISION_DISTANCE_SQ) {
          const dist = Math.sqrt(distSq)
          const repForce = BOO_REPULSION_CONSTANT / distSq
          fx += (dx / dist) * repForce
          fy += (dy / dist) * repForce
        }
      }
    }

    // Integrate velocity + per-particle damping
    const d = p.kind === 'boo' ? BOO_DAMPING : DAMPING
    const maxV = p.kind === 'boo' ? BOO_MAX_VELOCITY : MAX_VELOCITY
    p.vx = Math.max(-maxV, Math.min(maxV, (p.vx + fx) * d))
    p.vy = Math.max(-maxV, Math.min(maxV, (p.vy + fy) * d))

    // Integrate position
    p.x += p.vx
    p.y += p.vy

    totalKE += p.vx * p.vx + p.vy * p.vy
  }

  // 3. Settle check — use per-particle average to avoid dense clusters never settling
  const avgKE = particles.length > 0 ? totalKE / particles.length : 0
  if (avgKE < SETTLE_THRESHOLD) {
    stopLoop()
  }

  // 4. Write changed positions to store
  let anyChanged = false
  const next = storeNodes.map((node) => {
    const p = particleMap.get(node.id)
    if (!p || p.pinned) return node
    const dx = Math.abs(node.position.x - p.x)
    const dy = Math.abs(node.position.y - p.y)
    if (dx < POSITION_EPSILON && dy < POSITION_EPSILON) return node
    anyChanged = true
    return { ...node, position: { x: p.x, y: p.y } }
  })
  if (anyChanged) {
    useGraphStore.setState({ nodes: next as GraphNode[] })
  }
}

// ─── Public API ──────────────────────────────────────────────────────────────

function initialize(nodes: GraphNode[], edges: GraphEdge[]): void {
  stopLoop()
  particles = []
  particleMap = new Map()

  // Build parent map: childNodeId → parentBooId
  const parentMap = new Map<string, string>()
  for (const edge of edges) {
    if (edge.type === 'skill' || edge.type === 'resource') {
      parentMap.set(edge.target, edge.source)
    }
  }

  // Cache Boo centers
  const booCenters = new Map<string, { cx: number; cy: number }>()
  for (const node of nodes) {
    if (node.type === 'boo') {
      booCenters.set(node.id, {
        cx: node.position.x + BOO_HALF_W,
        cy: node.position.y + BOO_HALF_H,
      })
    }
  }

  // Create particles for skill/resource nodes
  for (const node of nodes) {
    if (node.type !== 'skill' && node.type !== 'resource') continue

    const parentBooId = parentMap.get(node.id)
    if (!parentBooId) continue // orphan — no physics

    const parentCenter = booCenters.get(parentBooId)
    if (!parentCenter) continue

    const halfW = node.type === 'skill' ? SKILL_HALF : RESOURCE_HALF_W
    const halfH = node.type === 'skill' ? SKILL_HALF : RESOURCE_HALF_H

    const pcx = node.position.x + halfW
    const pcy = node.position.y + halfH
    const dx = pcx - parentCenter.cx
    const dy = pcy - parentCenter.cy
    const restRadius = Math.sqrt(dx * dx + dy * dy)

    const particle: Particle = {
      id: node.id,
      x: node.position.x,
      y: node.position.y,
      vx: 0,
      vy: 0,
      parentBooId,
      restRadius: Math.max(restRadius, 1), // avoid zero rest radius
      halfW,
      halfH,
      pinned: false,
      kind: node.type === 'skill' ? 'skill' : 'resource',
    }
    particles.push(particle)
    particleMap.set(node.id, particle)
  }

  // Create particles for Boo nodes (for Boo-Boo collision)
  for (const node of nodes) {
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
    particleMap.set(node.id, particle)
  }
}

function pinNode(nodeId: string): void {
  const p = particleMap.get(nodeId)
  if (p) p.pinned = true
}

function unpinNode(nodeId: string): void {
  const p = particleMap.get(nodeId)
  if (p) {
    p.pinned = false
    // Sync position from store (user may have dragged the node)
    const node = useGraphStore.getState().nodes.find((n) => n.id === nodeId)
    if (node) {
      p.x = node.position.x
      p.y = node.position.y
    }
    p.vx = 0
    p.vy = 0
  }
  startLoop()
}

function wake(): void {
  startLoop()
}

function restart(): void {
  stopLoop()
  const { nodes, edges } = useGraphStore.getState()
  initialize(nodes, edges)
}

function dispose(): void {
  stopLoop()
  particles = []
  particleMap = new Map()
}

function isActive(): boolean {
  return active
}

// ─── Singleton export ────────────────────────────────────────────────────────

export const graphPhysics = {
  initialize,
  pinNode,
  unpinNode,
  wake,
  restart,
  dispose,
  isActive,
}
