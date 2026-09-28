import { centreOf, distanceToSegment, LOOSE_TILE, looseScale } from './looseNodes'
import type { Placed, Segment } from './looseNodes'

// ─── Where a team's status pill sits ─────────────────────────────────────────
//
// Beside its team's badge, on a side no line leaves by.
//
// STRAIGHT ABOVE THE BADGE IS ON A LINE in both Atlas layouts. In the tree, the
// drop from Boo Zero's trunk comes down into the badge from above, and zoomed
// out the trunk itself runs across that spot. In radial, a team's spokes leave
// its badge in whatever directions the layout turned it, up included.
//
// So each pill tries a short list of sides, right first because a label reads
// after its icon, and takes the first that is clear of every line on screen,
// every Boo and tile, every other team's badge and every pill already placed.
// When none is clear, which only happens with teams packed tighter than their
// pills are wide, it takes the side with the most room.
//
// Everything here is in screen pixels measured from the graph's origin (graph
// units times the zoom), so the answer holds while the canvas pans and only
// changes when it zooms.

/** The sides a pill tries, in order. */
export const PILL_SIDES = [
  'right',
  'left',
  'above-right',
  'above-left',
  'below-right',
  'below-left',
  'above',
  'below',
] as const

export type PillSide = (typeof PILL_SIDES)[number]

/** An axis-aligned box, by its centre and half extents. */
export interface Box {
  cx: number
  cy: number
  hw: number
  hh: number
  /** The team-root a badge's box belongs to, so its own pill can sit beside it. */
  id?: string
}

/** A pill to place: the junction it labels, and how wide it draws. */
export interface PillRequest {
  /** The team-root node's id. */
  id: string
  /** The junction, in screen pixels from the graph origin. */
  x: number
  y: number
  width: number
}

export interface PillPlacement {
  side: PillSide
  box: Box
}

/** Air a side needs to count as clear, in screen pixels. */
const MIN_CLEAR = 4
/** Half a routing line's on-screen width, near enough at every zoom. */
const LINE_HALF_WIDTH = 1

/** The pill's box on `side` of a badge whose clear radius is `clear`. */
export function sideBox(
  side: PillSide,
  x: number,
  y: number,
  hw: number,
  hh: number,
  clear: number,
): Box {
  // The diagonal sides put the pill's nearest corner on the badge's diagonal.
  const d = clear / Math.SQRT2
  switch (side) {
    case 'right':
      return { cx: x + clear + hw, cy: y, hw, hh }
    case 'left':
      return { cx: x - clear - hw, cy: y, hw, hh }
    case 'above':
      return { cx: x, cy: y - clear - hh, hw, hh }
    case 'below':
      return { cx: x, cy: y + clear + hh, hw, hh }
    case 'above-right':
      return { cx: x + d + hw, cy: y - d - hh, hw, hh }
    case 'above-left':
      return { cx: x - d - hw, cy: y - d - hh, hw, hh }
    case 'below-right':
      return { cx: x + d + hw, cy: y + d + hh, hw, hh }
    case 'below-left':
      return { cx: x - d - hw, cy: y + d + hh, hw, hh }
  }
}

/** The gap between two boxes, negative when they overlap. */
export function boxGap(a: Box, b: Box): number {
  const dx = Math.abs(a.cx - b.cx) - a.hw - b.hw
  const dy = Math.abs(a.cy - b.cy) - a.hh - b.hh
  if (dx < 0 && dy < 0) return Math.max(dx, dy)
  return Math.hypot(Math.max(dx, 0), Math.max(dy, 0))
}

/** Whether a segment passes through a box (Liang-Barsky clipping). */
function crosses(s: Segment, b: Box): boolean {
  const dx = s.x2 - s.x1
  const dy = s.y2 - s.y1
  const edges: ReadonlyArray<readonly [number, number]> = [
    [-dx, s.x1 - (b.cx - b.hw)],
    [dx, b.cx + b.hw - s.x1],
    [-dy, s.y1 - (b.cy - b.hh)],
    [dy, b.cy + b.hh - s.y1],
  ]
  let t0 = 0
  let t1 = 1
  for (const [p, q] of edges) {
    if (p === 0) {
      if (q < 0) return false
      continue
    }
    const t = q / p
    if (p < 0) {
      if (t > t1) return false
      t0 = Math.max(t0, t)
    } else {
      if (t < t0) return false
      t1 = Math.min(t1, t)
    }
  }
  return true
}

/** The gap between a box and a segment, negative when the segment crosses it. */
export function lineGap(b: Box, s: Segment): number {
  if (crosses(s, b)) return -1
  const point = { cx: 0, cy: 0, hw: 0, hh: 0 }
  let gap = Math.min(
    boxGap(b, { ...point, cx: s.x1, cy: s.y1 }),
    boxGap(b, { ...point, cx: s.x2, cy: s.y2 }),
  )
  for (const x of [b.cx - b.hw, b.cx + b.hw]) {
    for (const y of [b.cy - b.hh, b.cy + b.hh]) {
      gap = Math.min(gap, distanceToSegment({ x, y }, s))
    }
  }
  return gap
}

/**
 * A side for every pill, placed in order so each keeps clear of the ones before.
 *
 * `badgeRadius` is the badge as drawn, its ring included; `gap` is the air
 * between it and its pill.
 */
export function placePills(
  requests: readonly PillRequest[],
  layout: {
    badgeRadius: number
    gap: number
    height: number
    segments: readonly Segment[]
    keepouts: readonly Box[]
  },
): Map<string, PillPlacement> {
  const clear = layout.badgeRadius + layout.gap
  const hh = layout.height / 2
  const placed = new Map<string, PillPlacement>()
  const taken: Box[] = []
  for (const req of requests) {
    const room = (box: Box): number => {
      let r = Infinity
      for (const s of layout.segments) r = Math.min(r, lineGap(box, s) - LINE_HALF_WIDTH)
      // The pill's own badge is what it sits beside, by construction.
      for (const k of layout.keepouts) if (k.id !== req.id) r = Math.min(r, boxGap(box, k))
      for (const t of taken) r = Math.min(r, boxGap(box, t))
      return r
    }
    let best: (PillPlacement & { room: number }) | null = null
    for (const side of PILL_SIDES) {
      const box = sideBox(side, req.x, req.y, req.width / 2, hh, clear)
      const r = room(box)
      if (!best || r > best.room) best = { side, box, room: r }
      if (r >= MIN_CLEAR) {
        best = { side, box, room: r }
        break
      }
    }
    if (!best) continue
    placed.set(req.id, { side: best.side, box: best.box })
    taken.push(best.box)
  }
  return placed
}

// ─── What else is on screen ──────────────────────────────────────────────────

/** A node as the keepouts read it. */
export interface KeepoutNode extends Placed {
  hidden?: boolean
  data?: unknown
}

/**
 * The boxes a pill keeps clear of, in screen pixels from the graph origin: each
 * Boo as drawn, each open orbital tile, each loose tile, and each team badge
 * (by its team-root's id).
 *
 * A Boo at rest is its circle with its name and counts under it; a running or
 * erroring one is its card. Approximate on purpose: generous enough that a pill
 * never lands on a Boo, and the Boos sit well away from the junctions anyway.
 */
export function keepoutsFrom(
  nodes: readonly KeepoutNode[],
  zoom: number,
  badgeRadius: number,
): Box[] {
  const out: Box[] = []
  for (const n of nodes) {
    if (n.hidden) continue
    const c = centreOf(n)
    const x = c.x * zoom
    const y = c.y * zoom
    const data = (n.data ?? {}) as { status?: string; isVisible?: boolean }
    if (n.type === 'team-root') {
      out.push({ id: n.id, cx: x, cy: y, hw: badgeRadius, hh: badgeRadius })
    } else if (n.type === 'boo') {
      const card = data.status === 'running' || data.status === 'error'
      // Graph units: the card, or the circle (above) and its labels (below).
      const [hw, up, down] = card ? [140, 85, 85] : [100, 45, 90]
      out.push({
        cx: x,
        cy: y + ((down - up) / 2) * zoom,
        hw: hw * zoom,
        hh: ((up + down) / 2) * zoom,
      })
    } else if (n.type === 'loose') {
      // The tile and its two lines of label, grown to the tile's floor.
      const k = looseScale(zoom) * zoom
      const up = LOOSE_TILE / 2
      const down = LOOSE_TILE / 2 + 30
      out.push({ cx: x, cy: y + ((down - up) / 2) * k, hw: 60 * k, hh: ((up + down) / 2) * k })
    } else if (data.isVisible !== false) {
      const w = n.measured?.width ?? n.width ?? 0
      const h = n.measured?.height ?? n.height ?? 0
      out.push({ cx: x, cy: y, hw: (w / 2) * zoom, hh: (h / 2) * zoom })
    }
  }
  return out
}
