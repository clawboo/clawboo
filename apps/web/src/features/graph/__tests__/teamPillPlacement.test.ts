// Where a team's status pill sits: beside its badge, on a side no line leaves
// by, clear of every other badge and pill.
//
// Screen pixels from the junction throughout, with the badge the size it draws
// at the usual Atlas zoom (a 28px disc and its ring).

import { describe, expect, it } from 'vitest'

import type { Segment } from '../looseNodes'
import {
  boxGap,
  keepoutsFrom,
  lineGap,
  PILL_SIDES,
  placePills,
  sideBox,
  type Box,
} from '../teamPillPlacement'

const BADGE_R = 16
const GAP = 6
const H = 22

function place(
  requests: { id: string; x: number; y: number; width: number }[],
  segments: Segment[],
  keepouts: Box[] = [],
) {
  return placePills(requests, { badgeRadius: BADGE_R, gap: GAP, height: H, segments, keepouts })
}

/** Every badge as a keepout, the way the layer hands them over. */
function badges(requests: { id: string; x: number; y: number }[]): Box[] {
  return requests.map((r) => ({ id: r.id, cx: r.x, cy: r.y, hw: BADGE_R, hh: BADGE_R }))
}

const line = (x1: number, y1: number, x2: number, y2: number): Segment => ({ x1, y1, x2, y2 })

describe('placePills', () => {
  it('sits beside the badge in the tree, off the drop from the trunk and the trunk itself', () => {
    // The drop from Boo Zero's trunk comes in from above, the trunk runs across
    // 45px up, and the line to the team's members leaves downward.
    const segments = [
      line(-300, -45, 300, -45),
      line(0, -45, 0, 0),
      line(0, 0, 0, 49),
      line(-120, 49, 120, 49),
    ]
    const req = { id: 'tr-a', x: 0, y: 0, width: 70 }
    const placed = place([req], segments, badges([req])).get('tr-a')!
    expect(placed.side).toBe('right')
    // Level with the badge, which is what makes it read as the badge's label.
    expect(placed.box.cy).toBe(0)
    for (const s of segments) expect(lineGap(placed.box, s)).toBeGreaterThanOrEqual(4)
  })

  it('moves off a spoke leaving to the right, in radial', () => {
    // A team on Boo Zero's lower right: the spoke in from Boo Zero comes from
    // the upper left, and its members fan out to the right and below.
    const segments = [
      line(-170, -98, 0, 0),
      line(0, 0, 118, 21),
      line(0, 0, 104, 60),
      line(0, 0, 70, 97),
    ]
    const req = { id: 'tr-b', x: 0, y: 0, width: 70 }
    const placed = place([req], segments, badges([req])).get('tr-b')!
    expect(placed.side).toBe('above-right')
    for (const s of segments) expect(lineGap(placed.box, s)).toBeGreaterThanOrEqual(4)
  })

  it('steps round a neighbour too close on its right, and never onto another pill', () => {
    const reqs = [
      { id: 'tr-1', x: 0, y: 0, width: 120 },
      { id: 'tr-2', x: 150, y: 0, width: 120 },
    ]
    const placed = place(reqs, [], badges(reqs))
    expect(placed.get('tr-1')!.side).toBe('left')
    expect(placed.get('tr-2')!.side).toBe('right')
    expect(boxGap(placed.get('tr-1')!.box, placed.get('tr-2')!.box)).toBeGreaterThan(0)
    // Neither pill sits on the other team's badge.
    expect(boxGap(placed.get('tr-1')!.box, badges(reqs)[1]!)).toBeGreaterThan(0)
    expect(boxGap(placed.get('tr-2')!.box, badges(reqs)[0]!)).toBeGreaterThan(0)
  })

  it('keeps a side clear as the canvas zooms in and the badge grows', () => {
    // The layer picks sides at the badge's floor zoom and keeps them, on the
    // grounds that zooming in only opens room. Spokes are rays from the
    // junction, so they scale; the pill does not; the badge grows.
    const spokes = (k: number) => [
      line(-170 * k, -98 * k, 0, 0),
      line(0, 0, 118 * k, 21 * k),
      line(0, 0, 104 * k, 60 * k),
      line(0, 0, 70 * k, 97 * k),
    ]
    const req = { id: 'tr-b', x: 0, y: 0, width: 70 }
    const { side } = place([req], spokes(1)).get('tr-b')!
    for (const [k, badge] of [
      [1.5, 22],
      [2, 28],
      [3, 40],
    ] as const) {
      const box = sideBox(side, 0, 0, 35, H / 2, badge + GAP)
      for (const s of spokes(k)) expect(lineGap(box, s)).toBeGreaterThanOrEqual(4)
    }
  })

  it('takes the side with the most room when no side is clear', () => {
    // Lines 12px above and below crowd both flanks, and a vertical through the
    // junction crosses straight above and below, so the diagonals have the
    // most air even though it is less than a clear side needs.
    const segments = [line(-300, -12, 300, -12), line(-300, 12, 300, 12), line(0, -300, 0, 300)]
    const req = { id: 'tr-c', x: 0, y: 0, width: 70 }
    expect(place([req], segments).get('tr-c')!.side).toBe('above-right')
  })

  it('tries every side, right first', () => {
    expect(PILL_SIDES[0]).toBe('right')
    expect(new Set(PILL_SIDES).size).toBe(8)
    // Each side keeps the pill off the badge by the gap, whichever way it goes.
    for (const side of PILL_SIDES) {
      const box = sideBox(side, 0, 0, 35, H / 2, BADGE_R + GAP)
      const nearest = Math.hypot(
        Math.max(Math.abs(box.cx) - box.hw, 0),
        Math.max(Math.abs(box.cy) - box.hh, 0),
      )
      expect(nearest).toBeCloseTo(BADGE_R + GAP, 5)
    }
  })
})

describe('lineGap', () => {
  it('reads a line through the box as no room, and a line beside it as the distance', () => {
    const box: Box = { cx: 0, cy: 0, hw: 10, hh: 5 }
    expect(lineGap(box, line(-20, -20, 20, 20))).toBeLessThan(0)
    expect(lineGap(box, line(-20, 9, 20, 9))).toBeCloseTo(4)
    // Past a corner, the distance is to the corner.
    expect(lineGap(box, line(13, 9, 30, 9))).toBeCloseTo(5)
  })
})

describe('keepoutsFrom', () => {
  const at = (x: number, y: number) => ({ x, y })

  it('covers a Boo, more of it when it opens into its card', () => {
    const idle = keepoutsFrom(
      [
        {
          id: 'boo-a',
          type: 'boo',
          position: at(0, 0),
          measured: { width: 280, height: 280 },
          data: { status: 'idle' },
        },
      ],
      0.5,
      16,
    )[0]!
    const running = keepoutsFrom(
      [
        {
          id: 'boo-a',
          type: 'boo',
          position: at(0, 0),
          measured: { width: 280, height: 280 },
          data: { status: 'running' },
        },
      ],
      0.5,
      16,
    )[0]!
    // Centred on the Boo (140, 140) at half zoom, reaching further down for
    // the name and counts under the circle.
    expect(idle.cx).toBe(70)
    expect(idle.cy - idle.hh).toBeCloseTo((140 - 45) * 0.5)
    expect(idle.cy + idle.hh).toBeCloseTo((140 + 90) * 0.5)
    expect(running.hw).toBeGreaterThan(idle.hw)
  })

  it('skips a closed ring, and names each badge by its team-root', () => {
    const boxes = keepoutsFrom(
      [
        {
          id: 'skill-a-web',
          type: 'skill',
          position: at(0, 0),
          measured: { width: 46, height: 46 },
          data: { isVisible: false },
        },
        { id: 'team-root-t1', type: 'team-root', position: at(100, 100), data: {} },
      ],
      1,
      16,
    )
    expect(boxes).toEqual([{ id: 'team-root-t1', cx: 100, cy: 100, hw: 16, hh: 16 }])
  })
})
