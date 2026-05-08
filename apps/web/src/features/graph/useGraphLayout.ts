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
  // Node placement: NETWORK_SIMPLEX produces balanced columns within each
  // layer (avoids one teammate hugging the left while another floats on
  // the right). LP-based, optimal for our team sizes.
  'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
  // Spacing tuned so the BOO_ENVELOPE (260px, accounts for orbital
  // children when expanded) clears between siblings AND between layers
  // with room for the bezier-curve dependency edge + arrowhead.
  'elk.spacing.nodeNode': '100',
  'elk.layered.spacing.nodeNodeBetweenLayers': '140',
  'elk.padding': '[top=40, left=40, bottom=40, right=40]',
}

// ─── Boo envelope dimensions ─────────────────────────────────────────────────
// The Boo node is now a 220×120 card (see `nodes/BooNode.tsx`). The envelope
// passed to ELK accounts for the card itself + the orbital children fan that
// appears when a Boo is expanded (peacock-feather expand). Skills sit on an
// inner ring at ~100–190px from the Boo's center, so we add ~200px of
// padding around the card so siblings clear the orbital children.
//
// Width-side has a slightly tighter envelope than height because expanded
// fans are quasi-circular but the card itself is wider than tall.
const BOO_ENVELOPE_WIDTH = 280
const BOO_ENVELOPE_HEIGHT = 280

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
