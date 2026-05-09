// ELK layout runs client-side only (called from useEffect in GhostGraph).
// Uses elk.bundled.js to avoid Next.js/webpack WebWorker bundling issues.
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode } from 'elkjs'
import type { GraphNode, GraphEdge, LayoutData } from './types'

// ─── Singleton ELK instance ───────────────────────────────────────────────────

const elk = new ELK()

// ─── ELK layout options ───────────────────────────────────────────────────────

const ELK_OPTIONS = {
  // Layered top-down hierarchy. Replaces the previous `stress` algorithm,
  // which produced organic 2D constellation placement and made the leader
  // → teammate flow illegible. Layered assigns each Boo to a "level" based
  // on its position in the dependency graph (no incoming edges = top of
  // the tree, longest path = bottom) — the conventional flow-chart shape.
  'elk.algorithm': 'layered',
  'elk.direction': 'DOWN',
  // Crossing minimization: fewer edge crossings = clearer hierarchy.
  // LAYER_SWEEP is the default barycentric heuristic and is fast on
  // small graphs (handful of Boos per team).
  'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
  // Node placement: BRANDES_KOEPF with BALANCED alignment runs all four
  // BK alignment passes (LEFT/RIGHT × UP/DOWN) and averages them, which
  // gives the cleanest symmetric tree placement — parents sit at the
  // visual midpoint of their children. NETWORK_SIMPLEX (the previous
  // strategy) snaps nodes to integer columns based on LP flow, which
  // produces beautifully balanced layouts when the children count is
  // ODD (parent lands on the natural middle column) but visibly skews the
  // parent to one side when the children count is EVEN (no middle column
  // exists, so the parent rounds to the left or right one). BK + BALANCED
  // averages out that rounding bias.
  'elk.layered.nodePlacement.strategy': 'BRANDES_KOEPF',
  'elk.layered.nodePlacement.bk.fixedAlignment': 'BALANCED',
  // Spacing tuned so the BOO_ENVELOPE (340px, accounts for orbital
  // children when expanded) clears between siblings AND between layers
  // with room for the bezier-curve dependency edge + arrowhead.
  'elk.spacing.nodeNode': '100',
  'elk.layered.spacing.nodeNodeBetweenLayers': '140',
  'elk.padding': '[top=40, left=40, bottom=40, right=40]',
}

// ─── Boo envelope dimensions ─────────────────────────────────────────────────
// The Boo renders centered inside this envelope (see BOO_FOOTPRINT in
// `nodes/BooNode.tsx`) so the visible Boo shape (75–78px circle / 220×120
// card) is anchored at envelope center — keeping ELK's sibling spacing math
// honest about where edges actually converge. Sized to clear the card's
// diagonal half-extent (~125px) plus the orbital children: skills on an
// inner ring at 150–220px and resources on an outer ring at 230–285px.
const BOO_ENVELOPE_WIDTH = 340
const BOO_ENVELOPE_HEIGHT = 340

// ─── Default node dimensions (used before ReactFlow measures them) ────────────

function defaultWidth(nodeType: string | undefined): number {
  if (nodeType === 'skill') return 100
  if (nodeType === 'resource') return 140
  return 160
}

function defaultHeight(nodeType: string | undefined): number {
  if (nodeType === 'skill') return 30
  if (nodeType === 'resource') return 64
  return 60
}

// ─── Main layout function ─────────────────────────────────────────────────────

/**
 * Run ELK auto-layout on the current graph.
 *
 * Nodes that already have a saved position (from a previous user drag or a
 * persisted layout) keep their position; only truly new nodes are placed by ELK.
 */
export async function computeElkLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  savedPositions: LayoutData['positions'],
): Promise<GraphNode[]> {
  if (nodes.length === 0) return nodes

  // Build the ELK graph; use measured dimensions when available.
  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: ELK_OPTIONS,
    children: nodes.map((node) => ({
      id: node.id,
      // Boo nodes always use the inflated envelope (not measured DOM size)
      // so ELK accounts for orbital children + card body when spacing nodes.
      width:
        node.type === 'boo'
          ? BOO_ENVELOPE_WIDTH
          : (node.measured?.width ?? defaultWidth(node.type)),
      height:
        node.type === 'boo'
          ? BOO_ENVELOPE_HEIGHT
          : (node.measured?.height ?? defaultHeight(node.type)),
    })),
    edges: edges.map((edge) => ({
      id: edge.id,
      sources: [edge.source],
      targets: [edge.target],
    })),
  }

  let result: ElkNode
  try {
    result = await elk.layout(elkGraph)
  } catch {
    // If ELK fails (e.g. disconnected graph) return nodes as-is
    return nodes
  }

  return nodes.map((node) => {
    // Prefer user-saved position over ELK result
    if (savedPositions[node.id]) {
      return { ...node, position: savedPositions[node.id]! }
    }
    const elkNode = result.children?.find((n) => n.id === node.id)
    if (elkNode?.x !== undefined && elkNode?.y !== undefined) {
      return { ...node, position: { x: elkNode.x, y: elkNode.y } }
    }
    return node
  })
}
