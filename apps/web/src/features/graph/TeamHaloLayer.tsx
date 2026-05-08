import { useMemo } from 'react'
import { useViewport } from '@xyflow/react'
import type { GraphNode, BooNodeData } from './types'

// ─── TeamHaloLayer ────────────────────────────────────────────────────────────
//
// Renders a colored convex-hull overlay behind each team's BooNodes, visually
// expressing the Skills → Agents → Teams hierarchy. Pure rendering layer —
// does NOT touch ReactFlow's node tree, physics engine, or ELK layout.
//
// Placement: absolute-positioned sibling BEFORE <ReactFlow> in GhostGraph's
// wrapper div. The inner SVG mirrors ReactFlow's pan/zoom via useViewport()
// so hulls stay locked to agent positions under all pane transforms.
//
// Fallback: N=1 teams render no halo (badge alone is enough). N=2 teams
// render a rounded bounding box (capsule) — a 2-point hull is degenerate
// and looks wrong. N≥3 teams use a Graham-scan convex hull inflated by
// HALO_PADDING via centroid-push.

const HALO_PADDING = 40
const LABEL_OFFSET = 20 // lift label above topmost hull vertex

// Default BooNode footprint (matches the 220×120 card defined in
// `nodes/BooNode.tsx` via BOO_CARD_WIDTH / BOO_CARD_HEIGHT). Used as a
// fallback for hull inflation when React Flow hasn't measured a node
// yet; once measured, `node.width` / `node.height` are preferred.
const DEFAULT_BOO_W = 220
const DEFAULT_BOO_H = 120

interface Point {
  x: number
  y: number
}

export interface TeamHaloGroup {
  teamId: string
  teamName: string
  teamColor: string
  teamEmoji: string
  nodes: GraphNode[]
}

// ─── Pure helpers ─────────────────────────────────────────────────────────────

/**
 * Groups graph nodes by `BooNodeData.teamId`. Skills/resources and teamless
 * Boos are excluded. Returns a Map keyed by teamId preserving insertion order.
 */
export function groupNodesByTeam(nodes: GraphNode[]): Map<string, TeamHaloGroup> {
  const groups = new Map<string, TeamHaloGroup>()
  for (const node of nodes) {
    if (node.type !== 'boo') continue
    const data = node.data as BooNodeData
    if (!data.teamId) continue
    const existing = groups.get(data.teamId)
    if (existing) {
      existing.nodes.push(node)
    } else {
      groups.set(data.teamId, {
        teamId: data.teamId,
        teamName: data.teamName ?? 'Team',
        teamColor: data.teamColor ?? '#E94560',
        teamEmoji: data.teamEmoji ?? '•',
        nodes: [node],
      })
    }
  }
  return groups
}

/**
 * Returns the convex hull of a set of 2D points in counter-clockwise order.
 * Graham scan. Handles edge cases:
 *   - 0 points → []
 *   - 1 point → [p]
 *   - 2 points → [p0, p1]
 *   - Collinear points → just the endpoints.
 */
export function computeConvexHull(points: Point[]): Point[] {
  if (points.length <= 2) return points.map((p) => ({ x: p.x, y: p.y }))

  // Find pivot: lowest y (tiebreak lowest x)
  let pivotIdx = 0
  for (let i = 1; i < points.length; i++) {
    const p = points[i]
    const best = points[pivotIdx]
    if (p.y < best.y || (p.y === best.y && p.x < best.x)) pivotIdx = i
  }
  const pivot = points[pivotIdx]

  // Sort remaining points by polar angle from pivot, then by distance
  const rest = points.filter((_, i) => i !== pivotIdx)
  rest.sort((a, b) => {
    const angleA = Math.atan2(a.y - pivot.y, a.x - pivot.x)
    const angleB = Math.atan2(b.y - pivot.y, b.x - pivot.x)
    if (angleA !== angleB) return angleA - angleB
    const distA = (a.x - pivot.x) ** 2 + (a.y - pivot.y) ** 2
    const distB = (b.x - pivot.x) ** 2 + (b.y - pivot.y) ** 2
    return distA - distB
  })

  // Graham scan: maintain stack, pop while top makes non-left turn
  const stack: Point[] = [pivot]
  for (const p of rest) {
    while (stack.length >= 2) {
      const top = stack[stack.length - 1]
      const below = stack[stack.length - 2]
      // Cross product of (below→top) × (top→p); ≤0 means non-left turn
      const cross = (top.x - below.x) * (p.y - below.y) - (top.y - below.y) * (p.x - below.x)
      if (cross <= 0) stack.pop()
      else break
    }
    stack.push(p)
  }

  return stack
}

/**
 * Expands a convex hull outward from its centroid by `padding` pixels.
 * Simple and deterministic; accuracy is acceptable for roughly-convex clusters
 * of agent Boos. Returns a new array, leaves input untouched.
 */
export function inflateHull(hull: Point[], padding: number): Point[] {
  if (hull.length === 0) return []
  if (hull.length === 1) return [{ x: hull[0].x, y: hull[0].y }]

  const cx = hull.reduce((sum, p) => sum + p.x, 0) / hull.length
  const cy = hull.reduce((sum, p) => sum + p.y, 0) / hull.length

  return hull.map((p) => {
    const dx = p.x - cx
    const dy = p.y - cy
    const len = Math.sqrt(dx * dx + dy * dy) || 1
    return {
      x: p.x + (dx / len) * padding,
      y: p.y + (dy / len) * padding,
    }
  })
}

/** Build an SVG path string from a hull polygon (closed). */
export function hullToPath(hull: Point[]): string {
  if (hull.length === 0) return ''
  const parts = hull.map((p, i) => `${i === 0 ? 'M' : 'L'} ${p.x.toFixed(2)},${p.y.toFixed(2)}`)
  parts.push('Z')
  return parts.join(' ')
}

/** Rounded-rect SVG path. Used as fallback for 2-node teams. */
export function rectToRoundedPath(x: number, y: number, w: number, h: number, r: number): string {
  const rr = Math.min(r, w / 2, h / 2)
  return [
    `M ${(x + rr).toFixed(2)},${y.toFixed(2)}`,
    `L ${(x + w - rr).toFixed(2)},${y.toFixed(2)}`,
    `Q ${(x + w).toFixed(2)},${y.toFixed(2)} ${(x + w).toFixed(2)},${(y + rr).toFixed(2)}`,
    `L ${(x + w).toFixed(2)},${(y + h - rr).toFixed(2)}`,
    `Q ${(x + w).toFixed(2)},${(y + h).toFixed(2)} ${(x + w - rr).toFixed(2)},${(y + h).toFixed(2)}`,
    `L ${(x + rr).toFixed(2)},${(y + h).toFixed(2)}`,
    `Q ${x.toFixed(2)},${(y + h).toFixed(2)} ${x.toFixed(2)},${(y + h - rr).toFixed(2)}`,
    `L ${x.toFixed(2)},${(y + rr).toFixed(2)}`,
    `Q ${x.toFixed(2)},${y.toFixed(2)} ${(x + rr).toFixed(2)},${y.toFixed(2)}`,
    'Z',
  ].join(' ')
}

function nodeCenter(node: GraphNode): Point {
  const w = (node.width as number | undefined) ?? DEFAULT_BOO_W
  const h = (node.height as number | undefined) ?? DEFAULT_BOO_H
  return {
    x: node.position.x + w / 2,
    y: node.position.y + h / 2,
  }
}

interface RenderedHalo {
  teamId: string
  path: string
  color: string
  label: string
  labelX: number
  labelY: number
}

/** Compute the rendered halo shape for a team group. Returns null for <2 nodes. */
function computeGroupHalo(group: TeamHaloGroup): RenderedHalo | null {
  if (group.nodes.length < 2) return null

  const centers = group.nodes.map(nodeCenter)

  let path: string
  if (centers.length === 2) {
    // Rounded bounding-box fallback — 2-point hulls are degenerate (a line).
    const minX = Math.min(centers[0].x, centers[1].x) - HALO_PADDING
    const minY = Math.min(centers[0].y, centers[1].y) - HALO_PADDING
    const maxX = Math.max(centers[0].x, centers[1].x) + HALO_PADDING
    const maxY = Math.max(centers[0].y, centers[1].y) + HALO_PADDING
    path = rectToRoundedPath(minX, minY, maxX - minX, maxY - minY, HALO_PADDING)
    const labelX = (minX + maxX) / 2
    return {
      teamId: group.teamId,
      path,
      color: group.teamColor,
      label: `${group.teamEmoji} ${group.teamName}`,
      labelX,
      labelY: minY - LABEL_OFFSET,
    }
  }

  const hull = computeConvexHull(centers)
  const inflated = inflateHull(hull, HALO_PADDING)
  path = hullToPath(inflated)

  // Label above topmost vertex of inflated hull
  let minY = Infinity
  let cx = 0
  for (const p of inflated) {
    if (p.y < minY) minY = p.y
    cx += p.x
  }
  cx /= inflated.length

  return {
    teamId: group.teamId,
    path,
    color: group.teamColor,
    label: `${group.teamEmoji} ${group.teamName}`,
    labelX: cx,
    labelY: minY - LABEL_OFFSET,
  }
}

// ─── React component ──────────────────────────────────────────────────────────

interface TeamHaloLayerProps {
  nodes: GraphNode[]
}

export function TeamHaloLayer({ nodes }: TeamHaloLayerProps) {
  const vp = useViewport()

  // Position fingerprint: quantized to integer pixels so sub-pixel drag
  // updates don't thrash the hull computation. 1px quantization is
  // imperceptible at the halo scale and keeps the memo stable during
  // active drag within a pixel bucket.
  const positionKey = useMemo(() => {
    const parts: string[] = []
    for (const node of nodes) {
      if (node.type !== 'boo') continue
      const data = node.data as BooNodeData
      if (!data.teamId) continue
      parts.push(`${node.id}:${node.position.x | 0}:${node.position.y | 0}:${data.teamId}`)
    }
    return parts.join('|')
  }, [nodes])

  const halos = useMemo(() => {
    const groups = groupNodesByTeam(nodes)
    const out: RenderedHalo[] = []
    for (const group of groups.values()) {
      const halo = computeGroupHalo(group)
      if (halo) out.push(halo)
    }
    return out
  }, [nodes, positionKey])

  if (halos.length === 0) return null

  // Stroke/font sizes are divided by zoom so they stay visually constant
  // under pan/zoom — the standard SVG-in-graph-space trick.
  const strokePx = 2 / Math.max(vp.zoom, 0.001)
  const dashPx = 6 / Math.max(vp.zoom, 0.001)
  const fontPx = 14 / Math.max(vp.zoom, 0.001)

  return (
    <div
      aria-hidden="true"
      style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        pointerEvents: 'none',
        zIndex: 0,
      }}
    >
      <svg width="100%" height="100%" style={{ overflow: 'visible' }}>
        <g transform={`translate(${vp.x}, ${vp.y}) scale(${vp.zoom})`}>
          {halos.map((halo) => (
            <g key={halo.teamId}>
              <path
                d={halo.path}
                fill={halo.color + '1F'}
                stroke={halo.color}
                strokeWidth={strokePx}
                strokeDasharray={`${dashPx} ${dashPx}`}
                strokeLinejoin="round"
              />
              <text
                x={halo.labelX}
                y={halo.labelY}
                fontSize={fontPx}
                fill={halo.color}
                fontWeight={600}
                textAnchor="middle"
                style={{
                  fontFamily: 'var(--font-cabinet-grotesk, sans-serif)',
                  letterSpacing: '0.02em',
                }}
              >
                {halo.label}
              </text>
            </g>
          ))}
        </g>
      </svg>
    </div>
  )
}
