// ELK layout runs client-side only (called from useEffect in GhostGraph).
// Uses elk.bundled.js to avoid Next.js/webpack WebWorker bundling issues.
import ELK from 'elkjs/lib/elk.bundled.js'
import type { ElkNode } from 'elkjs'
import type { GraphNode, GraphEdge, LayoutData } from './types'

// ─── Singleton ELK instance ───────────────────────────────────────────────────

const elk = new ELK()

// ─── ELK layout options ───────────────────────────────────────────────────────

const ELK_OPTIONS = {
  // Stress layout: produces compact, balanced, organic placements.
  // Unlike 'layered' (which creates rigid vertical/horizontal chains),
  // stress minimization distributes nodes evenly in 2D space.
  'elk.algorithm': 'stress',
  'elk.stress.desiredEdgeLength': '300',
  'elk.spacing.nodeNode': '80',
  'elk.padding': '[top=20, left=20, bottom=20, right=20]',
}

// ─── Boo envelope dimensions ─────────────────────────────────────────────────
// Compact envelope: just enough for the Boo + inner skill ring.
// Orbital children may slightly overlap between adjacent Boos — that's
// acceptable and creates a natural, dense constellation look.
const BOO_ENVELOPE = 260

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
      // so ELK accounts for orbital children when spacing nodes.
      width: node.type === 'boo' ? BOO_ENVELOPE : (node.measured?.width ?? defaultWidth(node.type)),
      height:
        node.type === 'boo' ? BOO_ENVELOPE : (node.measured?.height ?? defaultHeight(node.type)),
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
