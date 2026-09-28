// Loose nodes: what the + button puts on a canvas, held by no agent yet.
//
// The id is the whole saved record (kind and ref, position beside it), so its
// round trip is what keeps a reload honest. Placement is the other half: a new
// node must land where it can be seen and grabbed, never on a Boo or a line.

import { beforeEach, describe, expect, it } from 'vitest'

import { BUILTIN_SKILLS } from '@/features/marketplace/catalog'

import {
  describeLoose,
  findFreeSpot,
  isLooseNodeId,
  LOOSE_TILE,
  looseNodeId,
  looseScale,
  makeLooseNode,
  obstaclesFrom,
  parseLooseNodeId,
  segmentsFrom,
  spotIsFree,
  useLooseNodeStore,
} from '../looseNodes'

const bounds = { minX: -1000, minY: -1000, maxX: 1000, maxY: 1000 }

describe('loose node ids', () => {
  it('round-trips a kind and ref, including a ref with a colon in it', () => {
    for (const [kind, ref] of [
      ['skill', 'web-search'],
      ['connector', 'gmail'],
      ['app', 'google:sheets'],
    ] as const) {
      expect(parseLooseNodeId(looseNodeId(kind, ref))).toEqual({ kind, ref })
    }
  })

  it('refuses anything that is not one', () => {
    expect(parseLooseNodeId('boo-a1')).toBeNull()
    expect(parseLooseNodeId('loose:')).toBeNull()
    expect(parseLooseNodeId('loose:weird:x')).toBeNull()
    expect(parseLooseNodeId('loose:skill:')).toBeNull()
    expect(isLooseNodeId('skill-a1-web')).toBe(false)
    expect(isLooseNodeId(looseNodeId('skill', 'x'))).toBe(true)
  })
})

describe('describeLoose', () => {
  it('names a skill from the catalog', () => {
    const skill = BUILTIN_SKILLS[0]!
    expect(describeLoose('skill', skill.id)).toMatchObject({
      kind: 'skill',
      name: skill.name,
      category: skill.category,
    })
  })

  it('skips a ref that no longer resolves, rather than drawing a blank tile', () => {
    expect(describeLoose('skill', 'no-such-skill')).toBeNull()
    expect(describeLoose('connector', 'no-such-connector')).toBeNull()
  })

  it('still draws an app the broker catalog dropped, under its toolkit name', () => {
    expect(describeLoose('app', 'not-a-real-toolkit')).toMatchObject({ name: 'not-a-real-toolkit' })
  })

  it('makes a node that counts as measured the moment it exists', () => {
    const node = makeLooseNode('atlas', describeLoose('skill', BUILTIN_SKILLS[0]!.id)!, {
      x: 0,
      y: 0,
    })
    expect(node.measured).toEqual({ width: LOOSE_TILE, height: LOOSE_TILE })
    expect(node.ariaLabel).toMatch(/not attached to an agent/)
  })
})

describe('placement', () => {
  it('takes the anchor itself when it is free', () => {
    expect(findFreeSpot({ x: 0, y: 0 }, 20, [], [], bounds)).toEqual({ x: 0, y: 0 })
  })

  it('steps off a node sitting on the anchor, and stays close', () => {
    const spot = findFreeSpot({ x: 0, y: 0 }, 20, [{ x: 0, y: 0, r: 70 }], [], bounds)
    expect(Math.hypot(spot.x, spot.y)).toBeGreaterThanOrEqual(70 + 20)
    expect(Math.hypot(spot.x, spot.y)).toBeLessThan(250)
  })

  it('keeps off a line, not only off nodes', () => {
    const line = { x1: -500, y1: 0, x2: 500, y2: 0 }
    const spot = findFreeSpot({ x: 0, y: 0 }, 20, [], [line], bounds)
    expect(Math.abs(spot.y)).toBeGreaterThanOrEqual(20)
  })

  it('never lands outside what is on screen', () => {
    const tight = { minX: 0, minY: 0, maxX: 200, maxY: 200 }
    const spot = findFreeSpot({ x: 500, y: 500 }, 20, [], [], tight)
    expect(spotIsFree(spot, 20, [], [], tight)).toBe(true)
  })

  it('draws a Boo as the Boo, not its 280 box, and a loose tile as drawn', () => {
    const [boo, loose] = obstaclesFrom(
      [
        {
          id: 'boo-a',
          type: 'boo',
          position: { x: 0, y: 0 },
          measured: { width: 280, height: 280 },
        },
        {
          id: 'loose:skill:x',
          type: 'loose',
          position: { x: 0, y: 0 },
          measured: { width: LOOSE_TILE, height: LOOSE_TILE },
        },
      ],
      0.25,
    )
    expect(boo).toEqual({ x: 140, y: 140, r: 70 })
    expect(loose!.r).toBeCloseTo((LOOSE_TILE / 2) * looseScale(0.25) + 10)
  })

  it('counts only the lines on screen at rest', () => {
    const nodes = [
      { id: 'a', position: { x: 0, y: 0 }, measured: { width: 0, height: 0 } },
      { id: 'b', position: { x: 100, y: 100 }, measured: { width: 0, height: 0 } },
    ]
    const drawn = segmentsFrom(nodes, [{ source: 'a', target: 'b', type: 'skill' }])
    expect(drawn).toHaveLength(1)
    // A hover-only route, a closed ring's line and a hidden edge are not seen.
    expect(
      segmentsFrom(nodes, [
        { source: 'a', target: 'b', type: 'dependency', data: { isPrimary: false } },
        { source: 'a', target: 'b', type: 'skill', data: { isVisible: false } },
        { source: 'a', target: 'b', type: 'skill', hidden: true },
      ]),
    ).toHaveLength(0)
    // A routing edge is kept clear of in the shape it is drawn: down, across and
    // down in the tree, one straight run in radial.
    expect(segmentsFrom(nodes, [{ source: 'a', target: 'b', type: 'dependency' }])).toEqual([
      { x1: 0, y1: 0, x2: 0, y2: 50 },
      { x1: 0, y1: 50, x2: 100, y2: 50 },
      { x1: 100, y1: 50, x2: 100, y2: 100 },
    ])
    expect(
      segmentsFrom(nodes, [
        { source: 'a', target: 'b', type: 'dependency', data: { layoutMode: 'radial' } },
      ]),
    ).toEqual([{ x1: 0, y1: 0, x2: 100, y2: 100 }])
  })

  it('keeps the tile legible when zoomed out, and at its size up close', () => {
    expect(looseScale(1)).toBe(1)
    expect(LOOSE_TILE * looseScale(0.25) * 0.25).toBeCloseTo(28)
  })
})

describe('the loose node store', () => {
  const node = (ref: string) =>
    makeLooseNode('atlas', describeLoose('skill', ref)!, { x: 10, y: 20 })

  beforeEach(() => useLooseNodeStore.setState({ byCanvas: {} }))

  it('refuses a second copy of the same thing on one canvas', () => {
    const ref = BUILTIN_SKILLS[0]!.id
    expect(useLooseNodeStore.getState().add('atlas', node(ref))).toBe(true)
    expect(useLooseNodeStore.getState().add('atlas', node(ref))).toBe(false)
    expect(useLooseNodeStore.getState().byCanvas['atlas']).toHaveLength(1)
  })

  it('keeps canvases apart', () => {
    const ref = BUILTIN_SKILLS[0]!.id
    useLooseNodeStore.getState().add('atlas', node(ref))
    expect(useLooseNodeStore.getState().byCanvas['team-t1']).toBeUndefined()
  })

  it('moves, then removes', () => {
    const n = node(BUILTIN_SKILLS[1]!.id)
    useLooseNodeStore.getState().add('atlas', n)
    useLooseNodeStore.getState().reposition('atlas', new Map([[n.id, { x: 99, y: 98 }]]))
    expect(useLooseNodeStore.getState().byCanvas['atlas']![0]!.position).toEqual({ x: 99, y: 98 })
    useLooseNodeStore
      .getState()
      .applyChanges('atlas', [{ type: 'position', id: n.id, position: { x: 5, y: 6 } }])
    expect(useLooseNodeStore.getState().byCanvas['atlas']![0]!.position).toEqual({ x: 5, y: 6 })
    useLooseNodeStore.getState().remove('atlas', n.id)
    expect(useLooseNodeStore.getState().byCanvas['atlas']).toHaveLength(0)
  })
})
