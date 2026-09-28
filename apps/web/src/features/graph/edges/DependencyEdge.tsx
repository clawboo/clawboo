import { memo } from 'react'
import {
  BaseEdge,
  EdgeLabelRenderer,
  getBezierPath,
  getSmoothStepPath,
  getStraightPath,
  useStore,
} from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useGraphStore } from '../store'
import { minScreenSize, useZoomStep } from '../useMinScreenSize'
import { TeamBadge } from '../nodes/TeamBadge'

// ─── DependencyEdge — Boo → Boo flow-chart connector ─────────────────────────
//
// Smooth-step (orthogonal) path with a small accent-red arrowhead at the
// target end. The arrowhead conveys direction (leader → teammate routing)
// at a glance, which is what gives the canvas its flow-chart feel under
// the layered ELK layout.
//
// `markerEnd` references `url(#dependency-arrow)` defined once in
// `<EdgeMarkers />` (mounted near the top of `GhostGraph`).
//
// **Primary vs secondary edges** (classical org-chart filter):
//   - Primary edges (BFS spanning tree from team leader) are always
//     visible; they form the readable hierarchy backbone.
//   - Secondary edges (every other routing rule) are HIDDEN at rest and
//     fade in only when their source or target Boo is hovered.
//   - The `isPrimary` flag is set in `useGraphData.buildGraphElements`
//     via `computeSpanningTree`. ELK only sees primary edges (filtered
//     in `GhostGraph.tsx`) so the layout itself isn't tangled by
//     secondary routes.
//
// **Trunk-and-branches rendering** for parents with multiple primary
// children. Without it, each parent → child edge draws its OWN vertical
// from the parent + horizontal at the elbow Y, and N stacked smooth-step
// paths produce a "rope" of 2–3 visible parallel lines — sub-pixel
// rendering differences make perfectly-overlapping strokes appear doubled.
// The fix:
//   - One sibling per parent is marked `isTrunkLeader: true` in
//     `useGraphData.ts` and renders the SHARED trunk anatomy as TWO
//     continuous subpaths (left half and right half), so the source
//     vertical, the trunk-to-corner arcs, and the corner branches form
//     uninterrupted strokes that visually flow into each other. Two
//     subpaths (instead of one big path) are needed so each corner
//     branch can have its own arrowhead via `marker-end` on its own
//     `<path>` element.
//   - Trunk followers (`isTrunkFollower: true`) render ONLY their branch.
//     Middle followers draw a sharp T-junction; corner followers render
//     NOTHING because the leader's continuous subpath already drew their
//     branch.
// Corner roundedness matches the user's spec: leftmost/rightmost children
// have rounded arcs where the trunk turns 90° downward into the branch;
// middle children have sharp T-junctions where the trunk continues past
// them. The corner radius shrinks if the trunk is narrower than 2×r so
// the two end-arcs never overlap.

interface DependencyEdgeData extends Record<string, unknown> {
  isPrimary?: boolean
  isTrunkLeader?: boolean
  isTrunkFollower?: boolean
  siblingTargetIds?: string[]
  /** When 'radial', skip trunk-and-branches and render a bezier. */
  layoutMode?: 'top-down' | 'radial'
  /**
   * Set on the edges that hang a team off Boo Zero in that team's own graph.
   * The edge wears the team's badge where it splits into the team: the same
   * mark Atlas draws on each team's junction node.
   */
  teamJunction?: string
}

/** The team's badge, centred on a point of the edge. */
function JunctionBadge({ teamId, x, y }: { teamId: string; x: number; y: number }) {
  return (
    <EdgeLabelRenderer>
      <div
        style={{
          position: 'absolute',
          width: 0,
          height: 0,
          transform: `translate(${x}px, ${y}px)`,
          // The label layer ignores the pointer; the badge takes it back so its
          // `title` names the team on hover.
          pointerEvents: 'all',
        }}
      >
        <TeamBadge teamId={teamId} />
      </div>
    </EdgeLabelRenderer>
  )
}

const STROKE = 'rgb(var(--primary-rgb) / 0.65)'
const STROKE_SELECTED = 'var(--primary)'
const STROKE_WIDTH = 2
const STROKE_WIDTH_SELECTED = 3
// On-screen floors, in CSS pixels. The canvas spends most of its life zoomed out
// (about 0.25 in Atlas, 0.3 in a team graph), where the graph-space width alone
// draws a sub-pixel hairline. See useMinScreenSize.ts.
const MIN_SCREEN_STROKE = 1.4
const MIN_SCREEN_STROKE_SELECTED = 2.2
/** The hover under-glow's width, as a multiple of the stroke it sits under. */
const GLOW_WIDTH_RATIO = 3.5
const TRUNK_CORNER_RADIUS = 12

// Trunk-and-branches assumes all siblings sit on ONE ELK row. When their Y
// values diverge beyond this tolerance (user dragged a child away, stale
// saved positions from an older layout), the trunk geometry degenerates into
// giant crossing rectangles — so past the tolerance every edge falls back to
// its own smooth-step path instead.
const TRUNK_COPLANAR_TOLERANCE = 40

// Build the LEFT half of the trunk leader's path: source vertical → left
// horizontal → left arc → leftmost branch. One continuous subpath so the
// stroke flows smoothly through every join. Marker lands at the leftmost
// target (the path's last point).
function buildLeftHalfPath(
  sourceX: number,
  sourceY: number,
  elbowY: number,
  leftmost: { x: number; y: number },
  cornerR: number,
): string {
  return (
    `M ${sourceX} ${sourceY}` +
    ` L ${sourceX} ${elbowY}` +
    ` L ${leftmost.x + cornerR} ${elbowY}` +
    // Quarter-arc going DOWN-LEFT (counter-clockwise, sweep flag 0)
    ` A ${cornerR} ${cornerR} 0 0 0 ${leftmost.x} ${elbowY + cornerR}` +
    ` L ${leftmost.x} ${leftmost.y}`
  )
}

// Build the RIGHT half of the trunk leader's path: trunk midpoint → right
// horizontal → right arc → rightmost branch. Marker lands at the rightmost
// target.
function buildRightHalfPath(
  sourceX: number,
  elbowY: number,
  rightmost: { x: number; y: number },
  cornerR: number,
): string {
  return (
    `M ${sourceX} ${elbowY}` +
    ` L ${rightmost.x - cornerR} ${elbowY}` +
    // Quarter-arc going DOWN-RIGHT (clockwise, sweep flag 1)
    ` A ${cornerR} ${cornerR} 0 0 1 ${rightmost.x} ${elbowY + cornerR}` +
    ` L ${rightmost.x} ${rightmost.y}`
  )
}

// Branch path for middle children (sharp T-junction).
function buildMiddleBranchPath(targetX: number, targetY: number, elbowY: number): string {
  return `M ${targetX} ${elbowY} L ${targetX} ${targetY}`
}

// Stable empty array reference so the useStore selector returns the same
// reference when there are no sibling targets — avoids re-render churn.
const EMPTY_SIBLINGS: Array<{ id: string; x: number; y: number }> = []

export const DependencyEdge = memo(function DependencyEdge({
  id,
  source,
  target,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  selected,
  data,
}: EdgeProps) {
  const edgeData = data as DependencyEdgeData | undefined
  const isPrimary = edgeData?.isPrimary !== false
  // In radial Atlas, the trunk-and-branches optimisation
  // (leftmost / middle / rightmost X-sort) doesn't apply. Suppressing the
  // trunk flags here lets the regular primary-edge bezier branch render.
  const isRadial = edgeData?.layoutMode === 'radial'
  const isTrunkLeader = isPrimary && !isRadial && edgeData?.isTrunkLeader === true
  const isTrunkFollower = isPrimary && !isRadial && edgeData?.isTrunkFollower === true
  const isTrunkParticipant = isTrunkLeader || isTrunkFollower

  // Pull sibling target positions from React Flow's internal node lookup.
  // We need them to compute the trunk path AND to know whether THIS edge's
  // target is the leftmost / rightmost sibling (corner — drawn by trunk
  // leader's continuous subpath) or a middle one (sharp T-junction drawn
  // separately). We carry the target ID alongside x/y so that "is this a
  // corner?" can be resolved by ID comparison rather than X-coordinate
  // equality. Necessary because React Flow's `targetX` measured handle
  // position includes the few-pixel offset from `useFloatingMotion`'s
  // transient transform on the floatRef wrapper, while the position we
  // read from `nodeLookup` is the static layout position — they differ
  // by 1–5px. Comparing by ID sidesteps that mismatch entirely.
  const siblingTargetIds = edgeData?.siblingTargetIds
  const siblings = useStore<Array<{ id: string; x: number; y: number }>>((rfState) => {
    if (!isTrunkParticipant || !siblingTargetIds) return EMPTY_SIBLINGS
    const out: Array<{ id: string; x: number; y: number }> = []
    for (const tid of siblingTargetIds) {
      const internal = rfState.nodeLookup.get(tid)
      if (!internal) continue
      const w = internal.measured?.width ?? 340
      const h = internal.measured?.height ?? 340
      out.push({
        id: tid,
        x: internal.position.x + w / 2,
        y: internal.position.y + h / 2,
      })
    }
    return out
  })

  const hoveredNodeId = useGraphStore((s) => s.hoveredNodeId)
  const isConnectedToHovered =
    hoveredNodeId !== null && (hoveredNodeId === source || hoveredNodeId === target)
  const zoom = useZoomStep()

  let opacity: number
  if (isPrimary) {
    opacity = hoveredNodeId === null || isConnectedToHovered ? 1 : 0.18
  } else {
    opacity = isConnectedToHovered ? 0.4 : 0
  }

  const stroke = selected ? STROKE_SELECTED : STROKE
  const strokeWidth = selected
    ? minScreenSize(STROKE_WIDTH_SELECTED, MIN_SCREEN_STROKE_SELECTED, zoom)
    : minScreenSize(STROKE_WIDTH, MIN_SCREEN_STROKE, zoom)
  const baseStyle = {
    stroke,
    strokeWidth,
    fill: 'none',
    strokeLinecap: 'round' as const,
    // Signature ease on the hover-cascade dim/brighten so edges fade as one
    // system with the nodes instead of snapping.
    transition: 'stroke 0.2s, stroke-width 0.2s, opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
    opacity,
    pointerEvents: opacity > 0 ? ('auto' as const) : ('none' as const),
  }
  const markerEnd = opacity > 0 ? 'url(#dependency-arrow)' : undefined

  // Soft under-glow when this edge belongs to the hovered cluster — the
  // routing lights up as one system. Rendered as a wider low-opacity twin
  // path beneath each visible subpath (always mounted so it can FADE).
  const glowOpacity = isConnectedToHovered ? 0.1 : 0
  const glowStyle = {
    stroke: 'var(--primary)',
    strokeWidth: strokeWidth * GLOW_WIDTH_RATIO,
    fill: 'none',
    strokeLinecap: 'round' as const,
    opacity: glowOpacity,
    transition: 'opacity 0.3s cubic-bezier(0.32, 0.72, 0, 1)',
    pointerEvents: 'none' as const,
  }
  const glowPath = (d: string, key: string) => <path key={key} d={d} style={glowStyle} />

  // ── Branch: secondary collaboration edge — bezier curve so it visually
  // distinguishes from the primary structural backbone.
  if (!isPrimary) {
    const [bezier] = getBezierPath({
      sourceX,
      sourceY,
      targetX,
      targetY,
      sourcePosition,
      targetPosition,
      curvature: 0.45,
    })
    return (
      <BaseEdge
        id={id}
        path={bezier}
        markerEnd={markerEnd}
        // Dashes track the stroke, or a floored stroke at low zoom closes its
        // own gaps and the dashed line reads as solid.
        style={{ ...baseStyle, strokeDasharray: `${strokeWidth * 2.5} ${strokeWidth * 2.5}` }}
      />
    )
  }

  // Shared-row check for the trunk system (see TRUNK_COPLANAR_TOLERANCE).
  // Non-coplanar siblings fall through to the per-edge smooth-step branch.
  let siblingsCoplanar = false
  if (isTrunkParticipant && siblings.length >= 2) {
    let minY = Infinity
    let maxY = -Infinity
    for (const s of siblings) {
      if (s.y < minY) minY = s.y
      if (s.y > maxY) maxY = s.y
    }
    siblingsCoplanar = maxY - minY <= TRUNK_COPLANAR_TOLERANCE
  }

  // ── Branch: trunk leader for a parent with 2+ siblings.
  if (isTrunkLeader && siblings.length >= 2 && siblingsCoplanar) {
    const sorted = [...siblings].sort((a, b) => a.x - b.x)
    const leftmost = sorted[0]!
    const rightmost = sorted[sorted.length - 1]!
    const elbowY = (sourceY + sorted[0]!.y) / 2
    const halfTrunkWidth = (rightmost.x - leftmost.x) / 2
    const cornerR = Math.min(TRUNK_CORNER_RADIUS, halfTrunkWidth)

    const leftPath = buildLeftHalfPath(sourceX, sourceY, elbowY, leftmost, cornerR)
    const rightPath = buildRightHalfPath(sourceX, elbowY, rightmost, cornerR)

    // If THIS leader edge's own target is a middle child (not a corner),
    // draw its branch too — the trunk subpaths only cover the corner
    // branches. Compare by target ID to avoid the floating-motion X
    // discrepancy between EdgeProps' targetX and the static layout x.
    const leaderIsCorner = target === leftmost.id || target === rightmost.id
    const leaderMiddlePath = leaderIsCorner ? null : buildMiddleBranchPath(targetX, targetY, elbowY)

    return (
      <>
        {glowPath(leftPath, `${id}-left-glow`)}
        {glowPath(rightPath, `${id}-right-glow`)}
        {leaderMiddlePath ? glowPath(leaderMiddlePath, `${id}-mid-glow`) : null}
        <BaseEdge id={`${id}-left`} path={leftPath} markerEnd={markerEnd} style={baseStyle} />
        <BaseEdge id={`${id}-right`} path={rightPath} markerEnd={markerEnd} style={baseStyle} />
        {leaderMiddlePath ? (
          <BaseEdge
            id={`${id}-mid`}
            path={leaderMiddlePath}
            markerEnd={markerEnd}
            style={baseStyle}
          />
        ) : null}
        {/* Where the single line down from the parent splits into the team. */}
        {edgeData?.teamJunction ? (
          <JunctionBadge teamId={edgeData.teamJunction} x={sourceX} y={elbowY} />
        ) : null}
      </>
    )
  }

  // ── Branch: trunk follower — middle child's sharp T-junction descent.
  if (isTrunkFollower && siblings.length >= 2 && siblingsCoplanar) {
    const sorted = [...siblings].sort((a, b) => a.x - b.x)
    const leftmostId = sorted[0]!.id
    const rightmostId = sorted[sorted.length - 1]!.id
    const isCornerBranch = target === leftmostId || target === rightmostId
    if (isCornerBranch) {
      // Corner branch — already drawn by the trunk leader's continuous
      // subpath. Render nothing to avoid the duplicate-stroke "rope".
      return null
    }
    const elbowY = (sourceY + sorted[0]!.y) / 2
    const middlePath = buildMiddleBranchPath(targetX, targetY, elbowY)
    return (
      <>
        {glowPath(middlePath, `${id}-glow`)}
        <BaseEdge id={id} path={middlePath} markerEnd={markerEnd} style={baseStyle} />
      </>
    )
  }

  // ── Branch: radial Atlas — primary edges radiate from BZ outward and from
  // each team-root outward to its members. Straight lines are the cleanest
  // visual for radial topology: bezier curves at the team-root convergence
  // make the joint look tangled, and smooth-step would route via orthogonal
  // handles (which assumes top-down). Arrowheads are also suppressed because
  // they all point at the invisible 1px team-root junction — they just add
  // noise at the convergence point without conveying direction.
  if (isRadial) {
    const [straight] = getStraightPath({ sourceX, sourceY, targetX, targetY })
    return (
      <>
        {glowPath(straight, `${id}-glow`)}
        <BaseEdge id={id} path={straight} style={baseStyle} />
      </>
    )
  }

  // ── Branch: single-child primary edge — standard smooth-step (no
  // trunk-and-branches needed because there's nothing to fork).
  const [smooth, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: TRUNK_CORNER_RADIUS,
  })
  // A team hung off Boo Zero by ONE edge (its lead, or a lone member) has no
  // split, so its badge sits halfway down the line. A trunk participant that
  // fell back here (siblings off one row) has no single split point to mark.
  const soloJunction = edgeData?.teamJunction && !isTrunkParticipant ? edgeData.teamJunction : null
  return (
    <>
      {glowPath(smooth, `${id}-glow`)}
      <BaseEdge id={id} path={smooth} markerEnd={markerEnd} style={baseStyle} />
      {soloJunction ? <JunctionBadge teamId={soloJunction} x={labelX} y={labelY} /> : null}
    </>
  )
})
