// Memory-graph layout. ELK `stress` (MDS-style — the right family for a
// weighted, heavily-disconnected similarity graph; Atlas's `layered` assumes a
// hierarchy this graph doesn't have) with `separateConnectedComponents` for
// organic cluster packing. ELK runs client-side only via elk.bundled.js (same
// import + d.ts-shim pattern as features/graph/useGraphLayout.ts). Any ELK
// throw or empty result falls back to the deterministic pure layouts below so
// the view can never render a stacked pile.

import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode } from 'elkjs'

export interface MemLayoutNode {
  id: string
  width: number
  height: number
}

export interface MemLayoutEdge {
  id: string
  source: string
  target: string
}

export type LayoutPositions = Map<string, { x: number; y: number }>

// Golden angle (radians) — Vogel's phyllotaxis spread. Adjacent indices land
// r = spacing·√i apart with a min pairwise distance ≈ spacing, so discs never
// pile up regardless of count.
const GOLDEN_ANGLE = 2.39996

const elk = new ELK()

const ELK_OPTIONS = {
  'elk.algorithm': 'org.eclipse.elk.stress',
  'org.eclipse.elk.stress.desiredEdgeLength': '150',
  'org.eclipse.elk.separateConnectedComponents': 'true',
  'org.eclipse.elk.spacing.componentComponent': '80',
  'org.eclipse.elk.aspectRatio': '1.6',
}

/** Pure golden-angle spiral: node i at r = spacing·√i, θ = i·GOLDEN_ANGLE,
 *  centered on `center`. Deterministic in input order. */
export function phyllotaxisLayout(
  nodes: readonly MemLayoutNode[],
  center: { x: number; y: number },
  spacing = 90,
): LayoutPositions {
  const out: LayoutPositions = new Map()
  nodes.forEach((n, i) => {
    const r = spacing * Math.sqrt(i)
    const theta = i * GOLDEN_ANGLE
    // Positions are React Flow node top-lefts; offset by half-size so the
    // spiral is over visual centers.
    out.set(n.id, {
      x: center.x + r * Math.cos(theta) - n.width / 2,
      y: center.y + r * Math.sin(theta) - n.height / 2,
    })
  })
  return out
}

/** Deterministic pure fallback: connected components (over the given edges)
 *  sorted size-desc (min-member-id tiebreak), each laid out phyllotactically,
 *  packed into a row-wrapped grid. Input-order invariant (nodes sorted by id
 *  up front) so a shuffled input yields byte-identical positions. */
export function fallbackClusterLayout(
  nodes: readonly MemLayoutNode[],
  edges: readonly MemLayoutEdge[],
): LayoutPositions {
  if (nodes.length === 0) return new Map()
  const sorted = [...nodes].sort((a, b) => (a.id < b.id ? -1 : 1))
  const byId = new Map(sorted.map((n) => [n.id, n]))

  // Union-find components (smaller root id wins — deterministic).
  const parent = new Map<string, string>()
  const find = (x: string): string => {
    let root = x
    while (root !== (parent.get(root) ?? root)) root = parent.get(root) ?? root
    let cur = x
    while (cur !== root) {
      const next = parent.get(cur) ?? cur
      parent.set(cur, root)
      cur = next
    }
    return root
  }
  for (const e of edges) {
    if (!byId.has(e.source) || !byId.has(e.target)) continue
    const ra = find(e.source)
    const rb = find(e.target)
    if (ra === rb) continue
    if (ra < rb) parent.set(rb, ra)
    else parent.set(ra, rb)
  }
  const componentsMap = new Map<string, MemLayoutNode[]>()
  for (const n of sorted) {
    const root = find(n.id)
    const list = componentsMap.get(root)
    if (list) list.push(n)
    else componentsMap.set(root, [n])
  }
  const components = [...componentsMap.values()].sort(
    (a, b) => b.length - a.length || (a[0]!.id < b[0]!.id ? -1 : 1),
  )

  // Per-component cell: the spiral's outer radius + the largest node's extent.
  const GAP = 80
  const cells = components.map((members) => {
    const spacing = 90
    const maxR = spacing * Math.sqrt(Math.max(0, members.length - 1))
    const maxExtent = Math.max(...members.map((m) => Math.max(m.width, m.height)))
    const size = 2 * maxR + maxExtent + GAP
    return { members, size }
  })

  // Row-wrapped grid: rows target the total-area square stretched to ~1.6
  // aspect; each row's height is its tallest cell. Size-desc order means big
  // clusters anchor the top-left, singleton dust wraps into the tail rows.
  const totalArea = cells.reduce((sum, c) => sum + c.size * c.size, 0)
  const targetRowWidth = Math.max(Math.sqrt(totalArea) * 1.28, cells[0]!.size)

  const out: LayoutPositions = new Map()
  let rowX = 0
  let rowY = 0
  let rowHeight = 0
  for (const cell of cells) {
    if (rowX > 0 && rowX + cell.size > targetRowWidth) {
      rowX = 0
      rowY += rowHeight
      rowHeight = 0
    }
    const center = { x: rowX + cell.size / 2, y: rowY + cell.size / 2 }
    const spiral = phyllotaxisLayout(cell.members, center)
    for (const [id, pos] of spiral) out.set(id, pos)
    rowX += cell.size
    rowHeight = Math.max(rowHeight, cell.size)
  }
  return out
}

/**
 * Async ELK stress layout over the given nodes + edges (callers feed
 * similarity + tag edges only — version edges are decoration, not geometry).
 * Falls back to `fallbackClusterLayout` on throw or an empty/degenerate result.
 */
export async function computeMemoryLayout(
  nodes: readonly MemLayoutNode[],
  edges: readonly MemLayoutEdge[],
): Promise<LayoutPositions> {
  if (nodes.length === 0) return new Map()
  try {
    const graph: ElkNode = {
      id: 'memory-root',
      layoutOptions: ELK_OPTIONS,
      children: nodes.map((n) => ({ id: n.id, width: n.width, height: n.height })),
      edges: edges.map((e) => ({ id: e.id, sources: [e.source], targets: [e.target] })),
    }
    const result = await elk.layout(graph)
    const out: LayoutPositions = new Map()
    for (const child of result.children ?? []) {
      if (child.x == null || child.y == null) continue
      out.set(child.id, { x: child.x, y: child.y })
    }
    if (out.size !== nodes.length) return fallbackClusterLayout(nodes, edges)
    return out
  } catch {
    return fallbackClusterLayout(nodes, edges)
  }
}
