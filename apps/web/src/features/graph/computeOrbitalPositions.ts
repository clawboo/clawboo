import type { GraphNode, GraphEdge, LayoutData } from './types'

// ─── FNV-1a hash (same as useFloatingMotion.ts — copied to avoid coupling) ──

function fnv1a(str: string): number {
  let hash = 2166136261
  for (let i = 0; i < str.length; i++) {
    hash ^= str.charCodeAt(i)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0
}

// ─── Constants ───────────────────────────────────────────────────────────────

// Inner skill ring sits clear of the 220×120 card's diagonal half-extent
// (~125px) plus a 25px gap. Outer resource ring sits beyond the inner ring
// with enough angular variance that the two rings don't visually merge.
const SKILL_RADIUS = { min: 150, max: 220 }
const RESOURCE_RADIUS = { min: 230, max: 285 }

/**
 * The fan size these radii were tuned for.
 *
 * The arc cannot open past a full circle, so once a Boo has more than a ringful the
 * angular gap between tiles shrinks and the discs collide at a FIXED radius. That is
 * what the old eight-tile cap was really protecting against, and capping meant a Boo
 * with forty capabilities silently showed eight of them. The canvas is infinite; the
 * ring was not. Growing the radius in step with the count keeps the gap between
 * neighbours roughly constant instead, because arc length is radius times angle.
 */
const COMFORTABLE_ORBIT_COUNT = 8

/** How much to push the rings out for a fan of `count`. Never pulls them in. */
function radiusScale(count: number): number {
  return Math.max(1, count / COMFORTABLE_ORBIT_COUNT)
}
const JITTER_RANGE = 12

// Offset from each Boo's React Flow `node.position` (top-left of the
// envelope) to its visual center. The Boo renders centered inside its
// envelope (BOO_FOOTPRINT = 280 in `nodes/BooNode.tsx`), so the center is
// at half the envelope size in each dimension.
const BOO_HALF_W = 140
const BOO_HALF_H = 140

// Node dimensions for centering orbital children — the unified orbital tile
// family (SkillNode CIRCLE + ResourceNode CIRCLE are both 46px discs; the
// Model tile is 57px but centering on 46 keeps it within a pixel-noise margin).
const SKILL_SIZE = 46 // CIRCLE const in SkillNode.tsx
const RESOURCE_W = 46 // CIRCLE const in ResourceNode.tsx
const RESOURCE_H = 46

// ─── Helpers ─────────────────────────────────────────────────────────────────

function computeCentroid(booNodes: GraphNode[]): { cx: number; cy: number } {
  if (booNodes.length === 0) return { cx: 0, cy: 0 }
  if (booNodes.length === 1) {
    // Single boo: fake centroid above so children orbit downward
    return {
      cx: booNodes[0]!.position.x + BOO_HALF_W,
      cy: booNodes[0]!.position.y + BOO_HALF_H - 200,
    }
  }
  let sumX = 0
  let sumY = 0
  for (const n of booNodes) {
    sumX += n.position.x + BOO_HALF_W
    sumY += n.position.y + BOO_HALF_H
  }
  return { cx: sumX / booNodes.length, cy: sumY / booNodes.length }
}

function awayAngle(booPos: { x: number; y: number }, centroid: { cx: number; cy: number }): number {
  const dx = booPos.x + BOO_HALF_W - centroid.cx
  const dy = booPos.y + BOO_HALF_H - centroid.cy
  if (dx === 0 && dy === 0) return Math.PI / 2 // fallback: downward
  return Math.atan2(dy, dx)
}

function arcSpread(count: number): number {
  if (count <= 1) return 0
  // Full circle: 2π × (count-1)/count — leaves one gap-sized slot toward the centroid.
  // count=2 → 180°, count=3 → 240°, count=5 → 288°, count=10 → 324°, count=16 → 337.5°
  return 2 * Math.PI * ((count - 1) / count)
}

function distributeOnArc(
  parentCenter: { x: number; y: number },
  baseAngle: number,
  children: GraphNode[],
  radiusRange: { min: number; max: number },
  savedPositions: LayoutData['positions'],
  // Peacock stagger metadata: this arc's children are indices
  // [orbitIndexOffset, orbitIndexOffset + children.length) within the parent
  // Boo's full fan of `orbitCount` orbitals (skills ring + resources ring).
  orbitIndexOffset: number,
  orbitCount: number,
): GraphNode[] {
  const count = children.length
  if (count === 0) return []

  const spread = arcSpread(count)
  const startAngle = baseAngle - spread / 2
  const angleStep = count === 1 ? 0 : spread / (count - 1)
  // Both rings scale by the SAME factor, taken from the whole fan rather than this
  // arc's own length, so the skills ring can never grow past the connectors ring and
  // swap their order.
  const scale = radiusScale(orbitCount)
  const scaledRange = { min: radiusRange.min * scale, max: radiusRange.max * scale }

  // Max distance from parent center before a saved position is considered stale
  const staleThreshold = scaledRange.max * 2

  return children.map((node, i) => {
    // Stamp the fan position (drives the peacock expand sweep order) on every
    // branch — including saved-position children, which still animate.
    const orbitData = { ...node.data, orbitIndex: orbitIndexOffset + i, orbitCount }

    // Respect user-dragged positions — but discard stale ones from previous layouts
    const saved = savedPositions[node.id]
    if (saved) {
      const nodeW = node.type === 'skill' ? SKILL_SIZE : RESOURCE_W
      const nodeH = node.type === 'skill' ? SKILL_SIZE : RESOURCE_H
      const savedCx = saved.x + nodeW / 2
      const savedCy = saved.y + nodeH / 2
      const dist = Math.sqrt((parentCenter.x - savedCx) ** 2 + (parentCenter.y - savedCy) ** 2)
      if (dist <= staleThreshold) {
        return { ...node, position: saved, data: orbitData } as GraphNode
      }
      // Stale saved position (e.g. from old layout) — fall through to orbital
    }

    const angle = startAngle + i * angleStep

    // Deterministic jitter from hash
    const hash = fnv1a(node.id)
    const radiusNorm = ((hash >>> 8) & 0xff) / 255
    const jitterNorm = ((hash >>> 0) & 0xff) / 255

    const baseRadius = scaledRange.min + radiusNorm * (scaledRange.max - scaledRange.min)
    const jitterOffset = (jitterNorm - 0.5) * 2 * JITTER_RANGE
    const radius = baseRadius + jitterOffset

    // Center the child node on the orbital point
    const nodeW = node.type === 'skill' ? SKILL_SIZE : RESOURCE_W
    const nodeH = node.type === 'skill' ? SKILL_SIZE : RESOURCE_H

    const x = parentCenter.x + Math.cos(angle) * radius - nodeW / 2
    const y = parentCenter.y + Math.sin(angle) * radius - nodeH / 2

    return { ...node, position: { x, y }, data: orbitData } as GraphNode
  })
}

// ─── Main function ───────────────────────────────────────────────────────────

export function computeOrbitalPositions(
  booNodes: GraphNode[],
  nonBooNodes: GraphNode[],
  edges: GraphEdge[],
  savedPositions: LayoutData['positions'],
): GraphNode[] {
  if (nonBooNodes.length === 0) return []
  if (booNodes.length === 0) return nonBooNodes

  // 1. Build parent → children map from edges
  const childrenByBoo = new Map<string, { skills: GraphNode[]; resources: GraphNode[] }>()

  for (const node of nonBooNodes) {
    const parentEdge = edges.find((e) => e.target === node.id)
    if (!parentEdge) continue
    const parentBooId = parentEdge.source

    let entry = childrenByBoo.get(parentBooId)
    if (!entry) {
      entry = { skills: [], resources: [] }
      childrenByBoo.set(parentBooId, entry)
    }
    if (node.type === 'skill') entry.skills.push(node)
    else if (node.type === 'resource') entry.resources.push(node)
  }

  // Sort children by ID for deterministic ordering
  for (const entry of childrenByBoo.values()) {
    entry.skills.sort((a, b) => a.id.localeCompare(b.id))
    entry.resources.sort((a, b) => a.id.localeCompare(b.id))
  }

  // 2. Compute centroid of all boo positions
  const centroid = computeCentroid(booNodes)

  // 3. Position each boo's children in orbital arcs
  const result: GraphNode[] = []

  for (const booNode of booNodes) {
    const children = childrenByBoo.get(booNode.id)
    if (!children) continue

    const parentCenter = {
      x: booNode.position.x + BOO_HALF_W,
      y: booNode.position.y + BOO_HALF_H,
    }
    const base = awayAngle(booNode.position, centroid)
    const fanCount = children.skills.length + children.resources.length

    // Skills: inner arc (fan indices 0..skills-1)
    result.push(
      ...distributeOnArc(
        parentCenter,
        base,
        children.skills,
        SKILL_RADIUS,
        savedPositions,
        0,
        fanCount,
      ),
    )

    // Resources: outer arc with slight angular offset to avoid stacking
    // (fan indices continue after the skills so the peacock sweep flows
    // inner ring → outer ring in one motion)
    const resourceOffset = children.skills.length > 0 ? 0.15 : 0
    result.push(
      ...distributeOnArc(
        parentCenter,
        base + resourceOffset,
        children.resources,
        RESOURCE_RADIUS,
        savedPositions,
        children.skills.length,
        fanCount,
      ),
    )
  }

  // 4. Handle orphan non-boo nodes (no parent edge — shouldn't happen)
  const positionedIds = new Set(result.map((n) => n.id))
  for (const node of nonBooNodes) {
    if (!positionedIds.has(node.id)) {
      result.push({ ...node, position: savedPositions[node.id] ?? node.position })
    }
  }

  return result
}
