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
  // Team-root is an invisible 1px routing point — ELK needs to position
  // it but it must NOT reserve a visible block of canvas around itself.
  if (nodeType === 'team-root') return 1
  if (nodeType === 'skill') return 100
  if (nodeType === 'resource') return 140
  return 160
}

function defaultHeight(nodeType: string | undefined): number {
  if (nodeType === 'team-root') return 1
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

// ─── Atlas layout (per-team ELK + manual team-root + BZ positioning) ─────────
//
// Goal: every team renders with its own self-contained internal hierarchy
// (matching its team-scoped Ghost Graph), and teams are visually distinct
// horizontal clusters with Boo Zero presiding at the top. The user's
// hand-drawn sketch maps directly:
//
//     Boo Zero               ← positioned manually at overall centroid X
//        │
//     ───┴───                ← TOP trunk = BZ's outgoing primary edges
//     │     │                  (one per team-root) rendered by the
//   TR-A  TR-B                trunk-and-branches edge logic
//    │     │                ← invisible 1px team-root junctions, placed
//   per-team-cluster          manually between BZ and each team's TOP
//
// We DON'T let ELK assign team-roots to layers globally, because different
// teams have different internal depths (one team might have 4 levels of
// AGENTS.md routing while another has 2). ELK's layered algorithm would
// place team A's members and team B's members at different Y coordinates
// because of unequal subtree depths — destroying the "all teams sit at
// the same level under Boo Zero" visual the sketch shows.
//
// Instead: per-team ELK lays out each team's INTERNAL Boo cluster
// independently. We then pack the clusters horizontally with a gap, and
// manually position team-roots + Boo Zero at coordinates that produce
// the two-trunk shape.

// Atlas spacing constants. Geometry is deliberate:
//
//   y = 0           ┌─ Boo Zero envelope top
//   y = 280         └─ Boo Zero envelope bottom (BZ source handle is here)
//   y = ATLAS_TEAM_ROOT_Y = 400      ← team-root junctions (1px, invisible)
//                                       BZ → team-root edges flow DOWNWARD
//                                       cleanly because team-root is below
//                                       BZ's envelope bottom by 120px.
//   y = ATLAS_TEAM_TOP_Y = 540       ← every team's members (same Y → flat
//                                       row, matches the user's sketch where
//                                       every team Boo sits on the same line)
//
// BZ envelope bottom must be ABOVE team-root.y, otherwise the smooth-step
// path bends backward and the arrowheads point UP — the "loose-end
// arrows" bug.
const ATLAS_MEMBER_GAP_X = 40 // horizontal gap between adjacent members within a team
const ATLAS_TEAM_GAP_X = 200 // horizontal gap between adjacent team clusters
const ATLAS_BZ_Y = 0 // Boo Zero's position.y (envelope top)
const ATLAS_TEAM_ROOT_Y = 400 // team-root junctions' position.y (well below BZ envelope bottom = 280)
const ATLAS_TEAM_TOP_Y = 540 // Y where each team's row of members starts

export async function computeAtlasLayout(
  nodes: GraphNode[],
  _primaryDepEdges: GraphEdge[],
  savedPositions: LayoutData['positions'],
  teamOrder: string[],
): Promise<GraphNode[]> {
  if (nodes.length === 0) return nodes

  // Partition nodes by role.
  let booZero: GraphNode | undefined
  const teamRoots: GraphNode[] = []
  const teamBoos: GraphNode[] = []
  for (const n of nodes) {
    if (n.type === 'boo') {
      const data = n.data as { isUniversalLeader?: boolean; teamId?: string | null }
      if (data.isUniversalLeader) {
        booZero = n
      } else if (data.teamId) {
        teamBoos.push(n)
      }
    } else if (n.type === 'team-root') {
      teamRoots.push(n)
    }
  }

  // Group team Boos by teamId
  const boosByTeam = new Map<string, GraphNode[]>()
  for (const n of teamBoos) {
    const teamId = (n.data as { teamId?: string | null }).teamId
    if (!teamId) continue
    if (!boosByTeam.has(teamId)) boosByTeam.set(teamId, [])
    boosByTeam.get(teamId)!.push(n)
  }

  // Order teams: stable from `teamOrder`, append unknowns at the end.
  const orderedTeamIds: string[] = []
  for (const id of teamOrder) {
    if (boosByTeam.has(id)) orderedTeamIds.push(id)
  }
  for (const id of boosByTeam.keys()) {
    if (!orderedTeamIds.includes(id)) orderedTeamIds.push(id)
  }

  // **Manual flat-row layout per team.** No ELK, no per-team sub-trees.
  // The user's sketch shows every team Boo on a single horizontal row
  // directly under its team-root. We honour that literally: each team
  // becomes one row of Boos at ATLAS_TEAM_TOP_Y, spaced
  // ATLAS_MEMBER_GAP_X apart. Internal AGENTS.md routing still exists
  // as SECONDARY edges (rendered on hover) so the routing data isn't
  // lost — just visually quieted.
  const packed: GraphNode[] = []
  const teamCentroidX = new Map<string, number>()
  const memberStrideX = BOO_ENVELOPE_WIDTH + ATLAS_MEMBER_GAP_X
  let xCursor = 0
  for (const teamId of orderedTeamIds) {
    const members = boosByTeam.get(teamId)!
    // Determinism: sort members by id so reloads produce a stable layout.
    const sortedMembers = [...members].sort((a, b) => a.id.localeCompare(b.id))
    const teamStart = xCursor
    for (let i = 0; i < sortedMembers.length; i++) {
      const m = sortedMembers[i]!
      packed.push({
        ...m,
        position: { x: teamStart + i * memberStrideX, y: ATLAS_TEAM_TOP_Y },
      })
    }
    const teamWidth = sortedMembers.length * memberStrideX - ATLAS_MEMBER_GAP_X
    // Centroid X for the team-root: midpoint between leftmost and
    // rightmost member's envelope centres.
    teamCentroidX.set(teamId, teamStart + teamWidth / 2 - BOO_ENVELOPE_WIDTH / 2)
    xCursor = teamStart + teamWidth + ATLAS_TEAM_GAP_X
  }
  const totalWidth = Math.max(0, xCursor - ATLAS_TEAM_GAP_X)
  const overallCentroidX = totalWidth / 2 - BOO_ENVELOPE_WIDTH / 2

  // Position team-root junctions at each team's centroid X. ATLAS_TEAM_ROOT_Y
  // is intentionally well below BZ's envelope bottom (280) so the smooth-
  // step BZ → team-root path flows DOWNWARD cleanly.
  for (const tr of teamRoots) {
    const teamId = (tr.data as { teamId?: string }).teamId
    const cx = teamId ? (teamCentroidX.get(teamId) ?? overallCentroidX) : overallCentroidX
    packed.push({
      ...tr,
      position: { x: cx, y: ATLAS_TEAM_ROOT_Y },
    })
  }

  // Position Boo Zero centered above all teams.
  if (booZero) {
    packed.push({
      ...booZero,
      position: { x: overallCentroidX, y: ATLAS_BZ_Y },
    })
  }

  // Apply user-saved positions LAST (same precedence as computeElkLayout).
  return packed.map((n) => (savedPositions[n.id] ? { ...n, position: savedPositions[n.id]! } : n))
}
