import { onReducedMotionChange, prefersReducedMotion } from '@/lib/prefersReducedMotion'

import { useGraphStore } from './store'
import type { GraphNode, GraphEdge } from './types'

// ─── Ghost Graph physics — d3-force-style velocity Verlet engine ─────────────
//
// A ground-up rewrite of the original ad-hoc spring/repulsion loop, modeled on
// d3-force's integration semantics (the canonical "feels right" reference for
// force-directed graphs — same math Obsidian's graph view is built on):
//
//   • **Alpha annealing** instead of a hard kinetic-energy cutoff. Every step:
//     `alpha += (alphaTarget - alpha) * ALPHA_DECAY`, and all *steering* forces
//     (springs, tethers) are scaled by alpha. Motion therefore fades out
//     asymptotically — no visible freeze the moment an energy threshold trips.
//     Interactions "reheat" the simulation by raising alpha / alphaTarget
//     (the d3 `alphaTarget(0.3).restart()` drag idiom).
//
//   • **Fixed-timestep accumulator** (60 Hz steps, ticked from rAF). The old
//     loop stepped once per rAF with a `>= 16ms` guard, which alternates
//     8/25ms effective steps on 120 Hz displays — visible cadence jitter.
//     Fixed steps make the motion identical on every refresh rate.
//
//   • **Soft collisions** à la d3.forceCollide: overlap is measured on the
//     *predicted* position (x + vx), resolved as a velocity impulse scaled by
//     strength < 1 and split by mass, and run for multiple iterations per
//     step. Soft approach + firm settle — no inverse-square force with a hard
//     distance cutoff (the old model's discontinuity was the "pop" source).
//
//   • **Tether anchors** for Boos: each Boo remembers its layout/dropped
//     position and is pulled gently back toward it (forceX/forceY-style,
//     strength scaled by alpha). Nodes shoved aside by a drag glide home
//     instead of accumulating drift.
//
//   • **Release inertia**: while pinned (dragged), the particle tracks an
//     EMA of the pointer velocity; on release that velocity is handed to the
//     particle so a flick glides and decays naturally instead of dead-stopping.
//
// Visibility-aware: collapsed orbital children (parent Boo not expanded) keep
// following their parent + spacing among siblings, but do NOT collide with
// other clusters or Boos — invisible nodes must never visibly push things.

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
  collideRadius: number
  mass: number
  pinned: boolean
  kind: 'boo' | 'skill' | 'resource'
  // Boo tether anchor (center coords). NaN for children.
  anchorX: number
  anchorY: number
  // Pointer-velocity tracking while pinned (px per step, EMA-smoothed).
  pinVX: number
  pinVY: number
  pinLastX: number
  pinLastY: number
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Integration — fixed 60 Hz steps regardless of display refresh rate.
const STEP_MS = 1000 / 60
const MAX_STEPS_PER_FRAME = 3 // clamp catch-up after a background tab / jank
const POSITION_EPSILON = 0.02 // minimum movement to trigger a store write

// Alpha annealing (d3 defaults: decay 0.0228 ≈ 300 steps ≈ 5s cool-down).
const ALPHA_DECAY = 0.0228
const ALPHA_MIN = 0.001
const ALPHA_DRAG_TARGET = 0.3 // sim temperature held while dragging
const ALPHA_WAKE = 0.35 // reheat level for wake() / expand / release

// Friction: velocity retained per step (1 - d3 velocityDecay). Children float
// (silky, cosmos-style low friction); Boos are deliberately heavier so they
// read as the weighty core the orbitals swing around.
const CHILD_VELOCITY_RETENTION = 0.76
const BOO_VELOCITY_RETENTION = 0.58

// Steering forces (all scaled by alpha each step).
const CHILD_SPRING_STRENGTH = 0.16 // spring toward parent's rest radius
const BOO_TETHER_STRENGTH = 0.07 // pull back toward layout/dropped anchor

// Soft collisions (d3.forceCollide semantics).
const COLLIDE_STRENGTH = 0.75
const COLLIDE_ITERATIONS = 2
const CHILD_COLLIDE_RADIUS = 36 // 46px tile + label breathing room
const BOO_COLLIDE_RADIUS = 92 // covers the 96–124px visual circle + name label
const CHILD_MASS = 1
const BOO_MASS = 10

// Gentle top-speed guards (px per 60Hz step) — not the old hard clamp that
// flattened all motion, just a ceiling against teleport-feel on huge yanks.
const CHILD_MAX_SPEED = 30
const BOO_MAX_SPEED = 12

// Release-velocity handoff.
const RELEASE_VELOCITY_SCALE = 0.9
const RELEASE_MAX_SPEED = 26

// Early sleep: after this many consecutive steps below the speed threshold
// (px/step, squared) with no alphaTarget heat, the loop stops entirely.
const SLEEP_SPEED_SQ = 0.02 * 0.02
const SLEEP_STILL_STEPS = 10

// Offset from each Boo's React Flow `node.position` (top-left of the
// envelope) to its visual center (BOO_FOOTPRINT = 280 in `nodes/BooNode.tsx`).
const BOO_HALF_W = 140
const BOO_HALF_H = 140

// Fallback half-sizes for center computation, used only until React Flow has
// measured the node (real measured dimensions are preferred in initialize).
// 46px is the orbital tile disc (`CIRCLE` in SkillNode/ResourceNode); the
// 57px Model tile and any future variation are covered by the measured path.
const CHILD_HALF_FALLBACK = 23 // 46 / 2

// ─── Internal state ──────────────────────────────────────────────────────────

let particles: Particle[] = []
let particleMap = new Map<string, Particle>()
let rafId: number | null = null
let lastFrameTime = 0
let accumulator = 0
let active = false
let alpha = 0
let alphaTarget = 0
let stillSteps = 0 // consecutive steps with near-zero motion → early sleep
let reducedMotionUnsub: (() => void) | null = null

// ─── RAF loop ────────────────────────────────────────────────────────────────

function startLoop(): void {
  if (active) return
  // Reduced motion: never start the relaxation loop. Deliberately the SINGLE
  // choke point — `wake()`, `pinNode()`, `unpinNode()` and any future caller
  // are all covered by this one check.
  //
  // "Never run" rather than "snap to settled" because there is no closed-form
  // settled state: `initialize` seeds particles FROM the ELK / orbital output
  // with v = 0, and only iteration discovers the rest. Crucially that output is
  // already a complete, non-overlapping layout — physics is post-hoc relaxation,
  // not the thing that positions nodes — so under reduced motion the graph is
  // still correct; only the settling animation and post-drag re-relaxation go.
  //
  // Safe in the node test env: prefersReducedMotion() returns false when
  // window/matchMedia are absent, so graphPhysics.test.ts is unaffected.
  if (prefersReducedMotion()) return
  active = true
  lastFrameTime = 0
  // Pre-fill one step so the first frame reacts immediately (a wake/drag
  // should never wait a full frame before anything moves).
  accumulator = STEP_MS
  stillSteps = 0
  rafId = requestAnimationFrame(frame)
}

function stopLoop(): void {
  active = false
  if (rafId !== null) {
    cancelAnimationFrame(rafId)
    rafId = null
  }
}

function frame(now: number): void {
  if (!active) {
    rafId = null
    return
  }
  if (lastFrameTime === 0) lastFrameTime = now
  // Clamp long gaps (background tab, GC pause) so we never spiral catching up.
  accumulator += Math.min(now - lastFrameTime, MAX_STEPS_PER_FRAME * STEP_MS)
  lastFrameTime = now

  let stepped = false
  while (accumulator >= STEP_MS) {
    accumulator -= STEP_MS
    step()
    stepped = true
    if (!active) break // step() may decide the sim is asleep
  }
  if (stepped && active) writePositions()

  if (active) {
    rafId = requestAnimationFrame(frame)
  } else {
    writePositions() // final sub-epsilon flush
    rafId = null
  }
}

// ─── Physics step (fixed 60 Hz) ──────────────────────────────────────────────

function step(): void {
  if (particles.length === 0) {
    stopLoop()
    return
  }

  // 1. Anneal.
  alpha += (alphaTarget - alpha) * ALPHA_DECAY
  if (alpha < ALPHA_MIN && alphaTarget < ALPHA_MIN) {
    alpha = 0
    stopLoop()
    return
  }

  const state = useGraphStore.getState()
  const expanded = state.expandedBooNodeIds

  // 2. Sync pinned particles from the store (user is dragging them) and
  //    track pointer velocity for the release handoff.
  syncPinnedFromStore(state.nodes)

  // 3. Steering forces (alpha-scaled).
  for (const p of particles) {
    if (p.pinned) continue

    if (p.kind === 'boo') {
      // Tether: glide back toward the layout/dropped anchor.
      if (Number.isFinite(p.anchorX)) {
        p.vx += (p.anchorX - (p.x + p.halfW)) * BOO_TETHER_STRENGTH * alpha
        p.vy += (p.anchorY - (p.y + p.halfH)) * BOO_TETHER_STRENGTH * alpha
      }
    } else {
      // Spring toward the parent Boo's rest radius.
      const parent = particleMap.get(p.parentBooId)
      if (parent) {
        const dx = parent.x + parent.halfW - (p.x + p.halfW)
        const dy = parent.y + parent.halfH - (p.y + p.halfH)
        const dist = Math.sqrt(dx * dx + dy * dy) || 1
        const f = ((dist - p.restRadius) / dist) * CHILD_SPRING_STRENGTH * alpha
        p.vx += dx * f
        p.vy += dy * f
      }
    }
  }

  // 4. Soft collisions (not alpha-scaled — overlaps always resolve; softness
  //    comes from strength < 1 + iteration blending, per d3.forceCollide).
  for (let iter = 0; iter < COLLIDE_ITERATIONS; iter++) {
    collide(expanded)
  }

  // 5. Integrate: friction, speed ceiling, position.
  let maxSpeedSq = 0
  for (const p of particles) {
    if (p.pinned) continue
    const retention = p.kind === 'boo' ? BOO_VELOCITY_RETENTION : CHILD_VELOCITY_RETENTION
    p.vx *= retention
    p.vy *= retention

    const maxSpeed = p.kind === 'boo' ? BOO_MAX_SPEED : CHILD_MAX_SPEED
    const speedSq = p.vx * p.vx + p.vy * p.vy
    if (speedSq > maxSpeed * maxSpeed) {
      const scale = maxSpeed / Math.sqrt(speedSq)
      p.vx *= scale
      p.vy *= scale
    }
    if (speedSq > maxSpeedSq) maxSpeedSq = speedSq

    p.x += p.vx
    p.y += p.vy
  }

  // 6. Early sleep: alpha's exponential tail lasts ~5s, but once every
  //    particle is visually still there's nothing left to anneal — stop the
  //    loop (zero CPU) instead of ticking out the tail.
  if (alphaTarget < ALPHA_MIN && maxSpeedSq < SLEEP_SPEED_SQ) {
    if (++stillSteps >= SLEEP_STILL_STEPS) {
      alpha = 0
      stopLoop()
    }
  } else {
    stillSteps = 0
  }
}

// Whether a child particle is currently revealed (its parent Boo expanded).
// Collapsed children still track their parent + space among siblings, but an
// invisible node must never push a visible one around.
function isRevealed(p: Particle, expanded: Set<string>): boolean {
  return expanded.has(p.parentBooId)
}

function collide(expanded: Set<string>): void {
  const n = particles.length
  for (let i = 0; i < n; i++) {
    const a = particles[i]!
    const aRevealed = a.kind !== 'boo' ? isRevealed(a, expanded) : true
    for (let j = i + 1; j < n; j++) {
      const b = particles[j]!

      // Pair gating.
      if (a.kind !== 'boo' && b.kind !== 'boo') {
        // child-child: same-parent siblings always keep spacing; cross-cluster
        // pairs only when both are revealed.
        if (a.parentBooId !== b.parentBooId) {
          if (!aRevealed || !isRevealed(b, expanded)) continue
        }
      } else if (a.kind !== b.kind) {
        // child-boo: only revealed children collide with Boos.
        const child = a.kind === 'boo' ? b : a
        if (!isRevealed(child, expanded)) continue
      }
      if (a.pinned && b.pinned) continue

      // Predicted positions (d3.forceCollide anticipates the next tick).
      const ax = a.x + a.halfW + a.vx
      const ay = a.y + a.halfH + a.vy
      const bx = b.x + b.halfW + b.vx
      const by = b.y + b.halfH + b.vy

      let dx = ax - bx
      let dy = ay - by
      let distSq = dx * dx + dy * dy
      const r = a.collideRadius + b.collideRadius
      if (distSq >= r * r) continue

      // Coincident centers: deterministic symmetry break.
      if (distSq < 1e-6) {
        dx = (i - j) * 0.01 || 0.01
        dy = ((i + j) % 2 === 0 ? 1 : -1) * 0.01
        distSq = dx * dx + dy * dy
      }

      const dist = Math.sqrt(distSq)
      const overlap = ((r - dist) / dist) * COLLIDE_STRENGTH
      const px = dx * overlap
      const py = dy * overlap

      // Mass split — pinned particles are immovable (infinite mass).
      const ma = a.pinned ? Infinity : a.mass
      const mb = b.pinned ? Infinity : b.mass
      if (ma === Infinity) {
        b.vx -= px
        b.vy -= py
      } else if (mb === Infinity) {
        a.vx += px
        a.vy += py
      } else {
        const wa = mb / (ma + mb)
        a.vx += px * wa
        a.vy += py * wa
        b.vx -= px * (1 - wa)
        b.vy -= py * (1 - wa)
      }
    }
  }
}

function syncPinnedFromStore(storeNodes: GraphNode[]): void {
  let nodeById: Map<string, GraphNode> | null = null
  for (const p of particles) {
    if (!p.pinned) continue
    if (!nodeById) {
      nodeById = new Map()
      for (const node of storeNodes) nodeById.set(node.id, node)
    }
    const node = nodeById.get(p.id)
    if (!node) continue
    // EMA of pointer velocity → handed to the particle on release.
    p.pinVX = p.pinVX * 0.7 + (node.position.x - p.pinLastX) * 0.3
    p.pinVY = p.pinVY * 0.7 + (node.position.y - p.pinLastY) * 0.3
    p.pinLastX = node.position.x
    p.pinLastY = node.position.y
    p.x = node.position.x
    p.y = node.position.y
  }
}

// ─── Store write (once per rAF, not per substep) ─────────────────────────────

function writePositions(): void {
  const storeNodes = useGraphStore.getState().nodes
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
  // Flipping the OS setting must take effect without a reload: turning reduced
  // motion ON stops a loop that is mid-simulation (every step is itself a valid
  // state, so nodes just freeze where they are), and turning it OFF lets the
  // next wake()/unpinNode() start it again. Registered lazily HERE rather than
  // at module scope so importing this file stays side-effect-free — the node
  // test project imports it directly. No-op when matchMedia is unavailable.
  if (!reducedMotionUnsub) {
    reducedMotionUnsub = onReducedMotionChange((reduced) => {
      if (reduced) stopLoop()
    })
  }
  particles = []
  particleMap = new Map()
  alpha = 0
  alphaTarget = 0

  // Build parent map: childNodeId → parentBooId
  const parentMap = new Map<string, string>()
  for (const edge of edges) {
    // `grant` is an orbital edge like skill/resource: it wraps OrbitalEdge and
    // ties a tile to its Boo. Omitting it here would leave a grant-backed tile
    // with no parent, so it would carry no spring and drift free of its agent.
    if (edge.type === 'skill' || edge.type === 'resource' || edge.type === 'grant') {
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

    // Prefer React Flow's measured size (covers the 57px Model tile);
    // fall back to the 46px tile family before first measure.
    const halfW = (node.measured?.width ?? CHILD_HALF_FALLBACK * 2) / 2
    const halfH = (node.measured?.height ?? CHILD_HALF_FALLBACK * 2) / 2

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
      collideRadius: CHILD_COLLIDE_RADIUS,
      mass: CHILD_MASS,
      pinned: false,
      kind: node.type === 'skill' ? 'skill' : 'resource',
      anchorX: NaN,
      anchorY: NaN,
      pinVX: 0,
      pinVY: 0,
      pinLastX: node.position.x,
      pinLastY: node.position.y,
    }
    particles.push(particle)
    particleMap.set(node.id, particle)
  }

  // Create particles for Boo nodes (collision + tether)
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
      collideRadius: BOO_COLLIDE_RADIUS,
      mass: BOO_MASS,
      pinned: false,
      kind: 'boo',
      anchorX: node.position.x + BOO_HALF_W,
      anchorY: node.position.y + BOO_HALF_H,
      pinVX: 0,
      pinVY: 0,
      pinLastX: node.position.x,
      pinLastY: node.position.y,
    }
    particles.push(particle)
    particleMap.set(node.id, particle)
  }

  // NOTE: initialize() leaves the engine inert — callers decide whether to
  // `wake()` (GhostGraph wakes gently after layout so orbital overlaps
  // resolve organically instead of freezing until the first interaction).
}

function pinNode(nodeId: string): void {
  const p = particleMap.get(nodeId)
  if (!p) return
  p.pinned = true
  p.pinVX = 0
  p.pinVY = 0
  p.pinLastX = p.x
  p.pinLastY = p.y
  // d3 drag idiom: hold the sim at a working temperature for the whole drag
  // so neighbors flow around the pinned node.
  alphaTarget = ALPHA_DRAG_TARGET
  alpha = Math.max(alpha, ALPHA_DRAG_TARGET)
  startLoop()
}

function unpinNode(nodeId: string): void {
  const p = particleMap.get(nodeId)
  // No particle → nothing to release, so nothing to relax. Returning here
  // (rather than falling through to the reheat below) keeps a drag of a
  // node the simulation doesn't own — an orphan skill / resource with no
  // parent edge, which `initialize` skips — from waking the loop and
  // nudging every unrelated node on the canvas.
  if (!p) return

  p.pinned = false
  // Sync position from store (user dragged the node there).
  const node = useGraphStore.getState().nodes.find((n) => n.id === nodeId)
  if (node) {
    p.x = node.position.x
    p.y = node.position.y
  }
  // Hand the pointer velocity to the particle — a flick glides.
  let vx = p.pinVX * RELEASE_VELOCITY_SCALE
  let vy = p.pinVY * RELEASE_VELOCITY_SCALE
  const speedSq = vx * vx + vy * vy
  if (speedSq > RELEASE_MAX_SPEED * RELEASE_MAX_SPEED) {
    const scale = RELEASE_MAX_SPEED / Math.sqrt(speedSq)
    vx *= scale
    vy *= scale
  }
  p.vx = vx
  p.vy = vy
  // A dropped Boo adopts the exact DROP POINT as its tether anchor — the
  // release glide overshoots, then rubber-bands home. Anchoring at the
  // drop point (not the glide endpoint) keeps the settled position in
  // agreement with the position persisted at drag-stop.
  if (p.kind === 'boo') {
    p.anchorX = p.x + p.halfW
    p.anchorY = p.y + p.halfH
  }

  // Cool down naturally (release keeps some heat so the settle is visible).
  alphaTarget = 0
  alpha = Math.max(alpha, ALPHA_WAKE)
  startLoop()
}

function wake(level: number = ALPHA_WAKE): void {
  alpha = Math.max(alpha, level)
  startLoop()
}

function restart(): void {
  stopLoop()
  const { nodes, edges } = useGraphStore.getState()
  initialize(nodes, edges)
}

function dispose(): void {
  stopLoop()
  reducedMotionUnsub?.()
  reducedMotionUnsub = null
  particles = []
  particleMap = new Map()
  alpha = 0
  alphaTarget = 0
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
