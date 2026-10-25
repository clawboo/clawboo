// Moves made on the org chart's radial layout from the browser panel: turning
// the graph around Boo Zero so a chosen team swings beside the panel, and posing
// a team so a chosen agent steps forward while the rest draw back. Pure
// geometry: the animation and the camera live in GhostGraph.

import { ATLAS_RADIAL_MEMBER_RADIUS } from './radialLayout'
import type { GraphEdge, GraphNode } from './types'

export interface Point {
  x: number
  y: number
}

/** A node's box size, as React Flow measured it (0 before it has). */
function sizeOf(n: GraphNode): { w: number; h: number } {
  return {
    w: n.measured?.width ?? n.width ?? 0,
    h: n.measured?.height ?? n.height ?? 0,
  }
}

/** The centre of a node's box, from its top-left position. */
export function centerOf(n: GraphNode): Point {
  const { w, h } = sizeOf(n)
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 }
}

/** Rotate `p` around `pivot` by `angle` radians (positive turns clockwise on
 *  screen, where y grows downward). */
export function rotatePoint(p: Point, pivot: Point, angle: number): Point {
  const cos = Math.cos(angle)
  const sin = Math.sin(angle)
  const dx = p.x - pivot.x
  const dy = p.y - pivot.y
  return { x: pivot.x + dx * cos - dy * sin, y: pivot.y + dx * sin + dy * cos }
}

/** The smallest turn from angle `from` to angle `to`, in (-π, π]. */
export function shortestTurn(from: number, to: number): number {
  let d = (to - from) % (2 * Math.PI)
  if (d <= -Math.PI) d += 2 * Math.PI
  if (d > Math.PI) d -= 2 * Math.PI
  return d
}

export interface TeamRotation {
  /** Boo Zero's centre: the hinge. */
  pivot: Point
  /** How far to turn the whole graph, in radians. */
  turn: number
}

/**
 * How far to turn the graph around Boo Zero so `teamId` points at `targetAngle`
 * (0 = straight right). The team's direction is its junction (the team-root
 * node) seen from Boo Zero. Null when there is no Boo Zero or no such team.
 */
export function planTeamRotation(
  nodes: readonly GraphNode[],
  teamId: string,
  targetAngle = 0,
): TeamRotation | null {
  const booZero = nodes.find(
    (n) => n.type === 'boo' && (n.data as { isUniversalLeader?: boolean }).isUniversalLeader,
  )
  const root = nodes.find(
    (n) => n.type === 'team-root' && (n.data as { teamId?: string }).teamId === teamId,
  )
  if (!booZero || !root) return null
  const pivot = centerOf(booZero)
  const at = centerOf(root)
  if (at.x === pivot.x && at.y === pivot.y) return null
  const angle = Math.atan2(at.y - pivot.y, at.x - pivot.x)
  return { pivot, turn: shortestTurn(angle, targetAngle) }
}

/** Each node's top-left position after turning the graph by `angle` around
 *  `pivot`, from the positions in `from` (keyed by node id). Nodes with no
 *  starting position are left where they are. */
export function rotatedPositions(
  nodes: readonly GraphNode[],
  from: ReadonlyMap<string, Point>,
  pivot: Point,
  angle: number,
): Map<string, Point> {
  const out = new Map<string, Point>()
  for (const n of nodes) {
    const start = from.get(n.id)
    if (!start) continue
    const { w, h } = sizeOf(n)
    const c = rotatePoint({ x: start.x + w / 2, y: start.y + h / 2 }, pivot, angle)
    out.set(n.id, { x: c.x - w / 2, y: c.y - h / 2 })
  }
  return out
}

/** How far a focused team's junction draws back toward Boo Zero. */
export const FOCUS_PULL = 200
/** How far past the team's resting reach the focused agent steps. */
export const FOCUS_PUSH = 40

function topLeftAt(n: GraphNode, c: Point): Point {
  const { w, h } = sizeOf(n)
  return { x: c.x - w / 2, y: c.y - h / 2 }
}

function isTeamMember(n: GraphNode, teamId: string): boolean {
  return (
    n.type === 'boo' &&
    !(n.data as { isUniversalLeader?: boolean }).isUniversalLeader &&
    (n.data as { teamId?: string | null }).teamId === teamId
  )
}

function isTeamRoot(n: GraphNode, teamId: string): boolean {
  return n.type === 'team-root' && (n.data as { teamId?: string }).teamId === teamId
}

/** Where a team's junction and members are right now, to return them to
 *  exactly that after a focus (rather than to a recomputed fan the physics has
 *  since spread apart). */
export function teamRestSnapshot(nodes: readonly GraphNode[], teamId: string): Map<string, Point> {
  const out = new Map<string, Point>()
  for (const n of nodes) {
    if (isTeamRoot(n, teamId) || isTeamMember(n, teamId)) out.set(n.id, { ...n.position })
  }
  return out
}

/** How far the others keep from the line out to a focused agent, so none sits
 *  on its link (a Boo's body plus a margin, in graph units). */
export const FOCUS_CLEARANCE = 130
/** The least distance kept between two neighbours on the same side. */
const MIN_GAP = 180

/**
 * A team posed around one of its agents (`focusNodeId`), starting from `rest`
 * (its snapshot): the junction draws back toward Boo Zero by FOCUS_PULL, so the
 * edge from Boo Zero shortens, and the focused agent steps out straight ahead,
 * past where the team reached.
 *
 * The others go with the junction and part around the line out to the focused
 * agent, so none sits on its link. Each keeps its distance from the junction,
 * and the members on each side keep their spacing; a side only swings outward
 * as far as its innermost member needs to clear FOCUS_CLEARANCE. A member that
 * sat on the line joins the side with fewer members.
 *
 * Null when there is no Boo Zero or no such team.
 */
export function focusedTeamPose(
  nodes: readonly GraphNode[],
  teamId: string,
  focusNodeId: string,
  rest: ReadonlyMap<string, Point>,
): Map<string, Point> | null {
  const booZero = nodes.find(
    (n) => n.type === 'boo' && (n.data as { isUniversalLeader?: boolean }).isUniversalLeader,
  )
  const root = nodes.find((n) => isTeamRoot(n, teamId))
  if (!booZero || !root) return null
  const pivot = centerOf(booZero)
  const rootRest = rest.get(root.id) ?? root.position
  const rootSize = sizeOf(root)
  const rootCenter = { x: rootRest.x + rootSize.w / 2, y: rootRest.y + rootSize.h / 2 }
  const dx = rootCenter.x - pivot.x
  const dy = rootCenter.y - pivot.y
  const distance = Math.hypot(dx, dy)
  if (distance === 0) return null
  const theta = Math.atan2(dy, dx)
  const ux = Math.cos(theta)
  const uy = Math.sin(theta)
  const newRoot = { x: rootCenter.x - FOCUS_PULL * ux, y: rootCenter.y - FOCUS_PULL * uy }

  const out = new Map<string, Point>()
  out.set(root.id, topLeftAt(root, newRoot))

  // The others, in polar terms around the junction: how far out, and at what
  // angle from the team's direction (negative on one side, positive the other).
  const others: Array<{ node: GraphNode; d: number; a: number }> = []
  for (const n of nodes) {
    if (!isTeamMember(n, teamId)) continue
    if (n.id === focusNodeId) {
      const reach = distance + ATLAS_RADIAL_MEMBER_RADIUS + FOCUS_PUSH
      out.set(n.id, topLeftAt(n, { x: pivot.x + reach * ux, y: pivot.y + reach * uy }))
      continue
    }
    const at = rest.get(n.id) ?? n.position
    const { w, h } = sizeOf(n)
    const vx = at.x + w / 2 - rootCenter.x
    const vy = at.y + h / 2 - rootCenter.y
    others.push({ node: n, d: Math.hypot(vx, vy), a: shortestTurn(theta, Math.atan2(vy, vx)) })
  }

  // The angle at which a member `d` out from the junction clears the line.
  const clearAngle = (d: number) => (d > 0 ? Math.asin(Math.min(1, FOCUS_CLEARANCE / d)) : 0)
  const onLine = (m: { d: number; a: number }) => Math.abs(m.a) < clearAngle(m.d)
  const left = others.filter((m) => m.a < 0 && !onLine(m))
  const right = others.filter((m) => m.a >= 0 && !onLine(m))
  for (const m of others.filter(onLine).sort((p, q) => Math.abs(p.a) - Math.abs(q.a))) {
    if (left.length < right.length || (left.length === right.length && m.a < 0)) left.push(m)
    else right.push(m)
  }

  // Swing each side out just far enough that its innermost member clears. A
  // member that crossed over from the other side counts as on the line. Then
  // keep neighbours a Boo apart, which only ever pushes outward.
  const place = (side: typeof others, sign: 1 | -1) => {
    const fromLine = (m: { a: number }) => Math.max(sign * m.a, 0)
    const sorted = [...side].sort((p, q) => fromLine(p) - fromLine(q))
    const inner = sorted[0]
    if (!inner) return
    const shift = Math.max(0, clearAngle(inner.d) - fromLine(inner))
    let previous = -Infinity
    for (const m of sorted) {
      const apart = m.d > 0 ? 2 * Math.asin(Math.min(1, MIN_GAP / 2 / m.d)) : 0
      const a = Math.max(fromLine(m) + shift, previous + apart)
      previous = a
      const angle = theta + sign * a
      out.set(
        m.node.id,
        topLeftAt(m.node, {
          x: newRoot.x + m.d * Math.cos(angle),
          y: newRoot.y + m.d * Math.sin(angle),
        }),
      )
    }
  }
  place(right, 1)
  place(left, -1)
  return out
}

/**
 * One frame of a move: each node part way (`progress`, 0..1) from where it
 * started (`from`) to where it is going (`to`, or staying put when absent),
 * with the whole graph turned by `turn * progress` around `pivot`.
 */
export function posedPositions(
  nodes: readonly GraphNode[],
  from: ReadonlyMap<string, Point>,
  to: ReadonlyMap<string, Point>,
  pivot: Point | null,
  turn: number,
  progress: number,
): Map<string, Point> {
  const out = new Map<string, Point>()
  for (const n of nodes) {
    const a = from.get(n.id)
    if (!a) continue
    const b = to.get(n.id) ?? a
    const p = { x: a.x + (b.x - a.x) * progress, y: a.y + (b.y - a.y) * progress }
    if (!pivot || turn === 0) {
      out.set(n.id, p)
      continue
    }
    const { w, h } = sizeOf(n)
    const c = rotatePoint({ x: p.x + w / 2, y: p.y + h / 2 }, pivot, turn * progress)
    out.set(n.id, { x: c.x - w / 2, y: c.y - h / 2 })
  }
  return out
}

/**
 * `to`, plus each moved Boo's orbital tiles (its skills, connectors, grants),
 * shifted by the same amount as their Boo, so a tile travels with its agent
 * instead of being left where the agent was.
 */
export function withOrbitals(
  edges: readonly GraphEdge[],
  from: ReadonlyMap<string, Point>,
  to: ReadonlyMap<string, Point>,
): Map<string, Point> {
  const out = new Map(to)
  for (const e of edges) {
    if (e.type !== 'skill' && e.type !== 'resource' && e.type !== 'grant') continue
    const parentFrom = from.get(e.source)
    const parentTo = to.get(e.source)
    const tile = from.get(e.target)
    if (!parentFrom || !parentTo || !tile || out.has(e.target)) continue
    out.set(e.target, {
      x: tile.x + parentTo.x - parentFrom.x,
      y: tile.y + parentTo.y - parentFrom.y,
    })
  }
  return out
}
