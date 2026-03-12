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

const SKILL_RADIUS = { min: 100, max: 190 }
const RESOURCE_RADIUS = { min: 180, max: 220 }
const JITTER_RANGE = 12

// Half of ELK default envelope for boo nodes (180×80)
const BOO_HALF_W = 90
const BOO_HALF_H = 40

// Node dimensions for centering orbital children
const SKILL_SIZE = 38 // CIRCLE const in SkillNode.tsx
const RESOURCE_W = 64
const RESOURCE_H = 70

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
): GraphNode[] {
  const count = children.length
  if (count === 0) return []

  const spread = arcSpread(count)
  const startAngle = baseAngle - spread / 2
  const angleStep = count === 1 ? 0 : spread / (count - 1)

  // Max distance from parent center before a saved position is considered stale
  const staleThreshold = radiusRange.max * 2

  return children.map((node, i) => {
    // Respect user-dragged positions — but discard stale ones from previous layouts
    const saved = savedPositions[node.id]
    if (saved) {
      const nodeW = node.type === 'skill' ? SKILL_SIZE : RESOURCE_W
      const nodeH = node.type === 'skill' ? SKILL_SIZE : RESOURCE_H
      const savedCx = saved.x + nodeW / 2
      const savedCy = saved.y + nodeH / 2
      const dist = Math.sqrt((parentCenter.x - savedCx) ** 2 + (parentCenter.y - savedCy) ** 2)
      if (dist <= staleThreshold) {
        return { ...node, position: saved }
      }
      // Stale saved position (e.g. from old layout) — fall through to orbital
    }

    const angle = startAngle + i * angleStep

    // Deterministic jitter from hash
    const hash = fnv1a(node.id)
    const radiusNorm = ((hash >>> 8) & 0xff) / 255
    const jitterNorm = ((hash >>> 0) & 0xff) / 255

    const baseRadius = radiusRange.min + radiusNorm * (radiusRange.max - radiusRange.min)
    const jitterOffset = (jitterNorm - 0.5) * 2 * JITTER_RANGE
    const radius = baseRadius + jitterOffset

    // Center the child node on the orbital point
    const nodeW = node.type === 'skill' ? SKILL_SIZE : RESOURCE_W
    const nodeH = node.type === 'skill' ? SKILL_SIZE : RESOURCE_H

    const x = parentCenter.x + Math.cos(angle) * radius - nodeW / 2
    const y = parentCenter.y + Math.sin(angle) * radius - nodeH / 2

    return { ...node, position: { x, y } }
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

    // Skills: inner arc
    result.push(
      ...distributeOnArc(parentCenter, base, children.skills, SKILL_RADIUS, savedPositions),
    )

    // Resources: outer arc with slight angular offset to avoid stacking
    const resourceOffset = children.skills.length > 0 ? 0.15 : 0
    result.push(
      ...distributeOnArc(
        parentCenter,
        base + resourceOffset,
        children.resources,
        RESOURCE_RADIUS,
        savedPositions,
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
