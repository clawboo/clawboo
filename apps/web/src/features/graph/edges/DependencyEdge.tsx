import { memo } from 'react'
import { BaseEdge, getBezierPath, getSmoothStepPath, useStore } from '@xyflow/react'
import type { EdgeProps } from '@xyflow/react'
import { useGraphStore } from '../store'

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
// **Primary vs secondary edges** (Paperclip-style org-chart filter):
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
}

const STROKE = 'rgba(233,69,96,0.65)'
const STROKE_SELECTED = '#E94560'
const STROKE_WIDTH = 1.5
const STROKE_WIDTH_SELECTED = 2.5
const TRUNK_CORNER_RADIUS = 12

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
  const isTrunkLeader = isPrimary && edgeData?.isTrunkLeader === true
  const isTrunkFollower = isPrimary && edgeData?.isTrunkFollower === true
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

  let opacity: number
  if (isPrimary) {
    opacity = hoveredNodeId === null || isConnectedToHovered ? 1 : 0.18
  } else {
    opacity = isConnectedToHovered ? 0.4 : 0
  }

  const stroke = selected ? STROKE_SELECTED : STROKE
  const strokeWidth = selected ? STROKE_WIDTH_SELECTED : STROKE_WIDTH
  const baseStyle = {
    stroke,
    strokeWidth,
    fill: 'none',
    transition: 'stroke 0.15s, stroke-width 0.15s, opacity 0.2s ease',
    opacity,
    pointerEvents: opacity > 0 ? ('auto' as const) : ('none' as const),
  }
  const markerEnd = opacity > 0 ? 'url(#dependency-arrow)' : undefined

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
        style={{ ...baseStyle, strokeDasharray: '4 4' }}
      />
    )
  }

  // ── Branch: trunk leader for a parent with 2+ siblings.
  if (isTrunkLeader && siblings.length >= 2) {
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
      </>
    )
  }

  // ── Branch: trunk follower — middle child's sharp T-junction descent.
  if (isTrunkFollower && siblings.length >= 2) {
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
    return <BaseEdge id={id} path={middlePath} markerEnd={markerEnd} style={baseStyle} />
  }

  // ── Branch: single-child primary edge — standard smooth-step (no
  // trunk-and-branches needed because there's nothing to fork).
  const [smooth] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
    borderRadius: TRUNK_CORNER_RADIUS,
  })
  return <BaseEdge id={id} path={smooth} markerEnd={markerEnd} style={baseStyle} />
})
