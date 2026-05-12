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
  // Spacing tuned so the BOO_ENVELOPE (280px, accounts for orbital
  // children when expanded) clears between siblings AND between layers
  // with room for the bezier-curve dependency edge + arrowhead.
  'elk.spacing.nodeNode': '80',
  // Inter-layer spacing. Used to be 140 (allowing room for long bezier
  // arrowheads + halo padding) but production showed this leaves massive
  // empty vertical bands for the common 2-layer "Boo Zero + member row"
  // case: 280 envelope + 140 gap + 280 envelope = 700 px vertical span
  // for a tree of tiny circles. Reduced to 60 — the edge head still has
  // room (arrows are <30 px), and `stretchToAspect` (below) handles
  // canvas-aspect adaptation if more vertical span is actually needed.
  'elk.layered.spacing.nodeNodeBetweenLayers': '60',
  'elk.padding': '[top=24, left=40, bottom=24, right=40]',
}

// ─── Boo envelope dimensions ─────────────────────────────────────────────────
// The Boo renders centered inside this envelope (see BOO_FOOTPRINT in
// `nodes/BooNode.tsx`) so the visible Boo shape (75–78px circle / 220×120
// card) is anchored at envelope center — keeping ELK's sibling spacing math
// honest about where edges actually converge.
//
// Tuned tighter than the orbital outer ring (220 px) so fitView can pack the
// canvas without leaving large empty bands on either side. Adjacent siblings'
// OUTER rings can briefly overlap in the gap region when BOTH parents are
// expanded — that's the trade-off for the boost in idle Boo legibility.
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

// ─── Aspect-ratio post-processing ────────────────────────────────────────────
// ELK lays out a hierarchy by topology, not by canvas geometry. For a
// star-shaped team (1 operator + many siblings) the output is wide-and-short;
// for a chain it's narrow-and-tall.
//
// `stretchToAspect` historically rescaled both axes to match the canvas
// aspect. That worked well for the **group-chat short-row canvas** (very
// wide, very short — a natural ELK layout leaves huge horizontal bands), but
// it ALSO triggered for the full Ghost Graph canvas (close to square), where
// it caused runaway vertical blowup: a natural 700×600 layout was being
// stretched to ~700×1054, then the saved-positions feedback loop (each
// re-layout reads back the already-stretched positions, stretches AGAIN,
// saves the bigger one) produced layouts spanning thousands of ELK units.
// One real user session ended up with Boo Zero at y=-2268 and members at
// y=2656 — total vertical span ≈ 4900 ELK units.
//
// **New rule** (Round 2 follow-up):
//   1. **Only ever stretch the X axis.** A wider-than-natural layout fills
//      horizontal empty bands without harming Boo prominence. The vertical
//      stretch was the harmful direction.
//   2. **Cap the X stretch factor at 1.6.** Above that the topology starts
//      to look distorted (siblings drift apart and bezier edges get long).
//   3. **Skip when the canvas aspect is close to the layout aspect.**
//      No stretch is needed when they already match.
//
// fitView handles the rest — if there's residual empty canvas, the camera
// just zooms in, which is the desired behaviour (it makes Boos more prominent).
function stretchToAspect(nodes: GraphNode[], targetAspect: number): GraphNode[] {
  if (nodes.length < 2 || !Number.isFinite(targetAspect) || targetAspect <= 0) {
    return nodes
  }
  // Compute bbox + position range from Boo positions (skill / resource nodes
  // follow their parent Boo via computeOrbitalPositions — they shouldn't
  // drive aspect).
  const boos = nodes.filter((n) => n.type === 'boo')
  if (boos.length < 2) return nodes
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity
  for (const n of boos) {
    if (n.position.x < minX) minX = n.position.x
    if (n.position.x > maxX) maxX = n.position.x
    if (n.position.y < minY) minY = n.position.y
    if (n.position.y > maxY) maxY = n.position.y
  }
  const posRangeX = maxX - minX
  const posRangeY = maxY - minY
  const bboxW = posRangeX + BOO_ENVELOPE_WIDTH
  const bboxH = posRangeY + BOO_ENVELOPE_HEIGHT
  if (bboxW <= 0 || bboxH <= 0) return nodes
  const layoutAspect = bboxW / bboxH

  // Only stretch X, only when layout is significantly TALLER than canvas
  // (i.e. natural layout leaves horizontal empty bands).
  let xScale = 1
  const MAX_STRETCH = 1.6
  const ASPECT_TOLERANCE = 0.15 // skip when aspects are within 15%
  if (layoutAspect < targetAspect * (1 - ASPECT_TOLERANCE) && posRangeX > 0) {
    const targetPosRange = Math.max(0, bboxH * targetAspect - BOO_ENVELOPE_WIDTH)
    xScale = Math.min(MAX_STRETCH, targetPosRange / posRangeX)
  }
  if (xScale === 1) return nodes
  const cx = (minX + maxX) / 2
  return nodes.map((n) => {
    if (n.type !== 'boo') return n
    return {
      ...n,
      position: {
        x: cx + (n.position.x - cx) * xScale,
        y: n.position.y,
      },
    }
  })
}

// ─── Main layout function ─────────────────────────────────────────────────────

/**
 * Run ELK auto-layout on the current graph.
 *
 * Nodes that already have a saved position (from a previous user drag or a
 * persisted layout) keep their position; only truly new nodes are placed by ELK.
 *
 * `targetAspect`, when provided, runs a post-ELK pass that stretches the
 * layout's bounding box to match the target aspect ratio (typically the
 * canvas aspect). This claims empty bands left by ELK's topology-driven
 * placement when the canvas is much wider or taller than the natural layout.
 */
export async function computeElkLayout(
  nodes: GraphNode[],
  edges: GraphEdge[],
  savedPositions: LayoutData['positions'],
  targetAspect?: number,
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

  const elkResolved = nodes.map((node) => {
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

  return targetAspect !== undefined ? stretchToAspect(elkResolved, targetAspect) : elkResolved
}
