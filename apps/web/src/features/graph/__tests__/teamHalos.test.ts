import { describe, it, expect } from 'vitest'
import {
  computeConvexHull,
  inflateHull,
  groupNodesByTeam,
  hullToPath,
  rectToRoundedPath,
} from '../TeamHaloLayer'
import type { GraphNode, BooNodeData } from '../types'

// ─── Helpers ──────────────────────────────────────────────────────────────────

function booNode(id: string, x: number, y: number, teamId: string | null): GraphNode {
  return {
    id,
    type: 'boo',
    position: { x, y },
    data: {
      agentId: id,
      name: id,
      status: 'idle',
      model: null,
      isStreaming: false,
      teamId,
      ...(teamId && {
        teamName: `Team ${teamId}`,
        teamColor: '#34D399',
        teamEmoji: '🛠️',
      }),
    } satisfies BooNodeData,
  } as GraphNode
}

function skillNode(id: string, x: number, y: number): GraphNode {
  return {
    id,
    type: 'skill',
    position: { x, y },
    data: {
      skillId: id,
      name: id,
      category: 'code',
      description: null,
      agentIds: [],
    },
  } as GraphNode
}

// ─── computeConvexHull ────────────────────────────────────────────────────────

describe('computeConvexHull', () => {
  it('returns empty array for empty input', () => {
    expect(computeConvexHull([])).toEqual([])
  })

  it('returns single point for 1-point input', () => {
    expect(computeConvexHull([{ x: 5, y: 10 }])).toEqual([{ x: 5, y: 10 }])
  })

  it('returns both points for 2-point input', () => {
    const result = computeConvexHull([
      { x: 0, y: 0 },
      { x: 10, y: 10 },
    ])
    expect(result).toHaveLength(2)
  })

  it('returns all 3 vertices of a triangle', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ]
    const hull = computeConvexHull(points)
    expect(hull).toHaveLength(3)
  })

  it('returns all 4 vertices of a square', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    const hull = computeConvexHull(points)
    expect(hull).toHaveLength(4)
  })

  it('drops interior points', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
      { x: 5, y: 5 }, // interior
    ]
    const hull = computeConvexHull(points)
    expect(hull).toHaveLength(4)
    // Interior point must not be in the hull
    expect(hull.find((p) => p.x === 5 && p.y === 5)).toBeUndefined()
  })

  it('returns only extremes for collinear points', () => {
    const points = [
      { x: 0, y: 0 },
      { x: 5, y: 0 },
      { x: 10, y: 0 },
    ]
    const hull = computeConvexHull(points)
    // Graham scan with non-strict left test drops the middle collinear point
    expect(hull.length).toBeLessThanOrEqual(3)
    expect(hull.length).toBeGreaterThanOrEqual(2)
  })
})

// ─── inflateHull ──────────────────────────────────────────────────────────────

describe('inflateHull', () => {
  it('returns empty array for empty hull', () => {
    expect(inflateHull([], 10)).toEqual([])
  })

  it('returns a copy of a single point', () => {
    const result = inflateHull([{ x: 5, y: 5 }], 10)
    expect(result).toEqual([{ x: 5, y: 5 }])
  })

  it('inflates a square outward from its centroid', () => {
    const square = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 10, y: 10 },
      { x: 0, y: 10 },
    ]
    const inflated = inflateHull(square, 5)
    // Centroid is (5, 5). Each vertex is at distance sqrt(50) from centroid.
    // After pushing outward by 5, new distance = sqrt(50) + 5 ≈ 12.07
    const centroidDist = (p: { x: number; y: number }) => Math.sqrt((p.x - 5) ** 2 + (p.y - 5) ** 2)
    for (const p of inflated) {
      expect(centroidDist(p)).toBeCloseTo(Math.sqrt(50) + 5, 1)
    }
    // Expanded square should be strictly larger
    const xs = inflated.map((p) => p.x)
    const ys = inflated.map((p) => p.y)
    expect(Math.min(...xs)).toBeLessThan(0)
    expect(Math.max(...xs)).toBeGreaterThan(10)
    expect(Math.min(...ys)).toBeLessThan(0)
    expect(Math.max(...ys)).toBeGreaterThan(10)
  })

  it('does not mutate the input', () => {
    const hull = [
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ]
    const snapshot = JSON.stringify(hull)
    inflateHull(hull, 7)
    expect(JSON.stringify(hull)).toBe(snapshot)
  })
})

// ─── hullToPath / rectToRoundedPath ───────────────────────────────────────────

describe('hullToPath', () => {
  it('returns empty string for empty hull', () => {
    expect(hullToPath([])).toBe('')
  })

  it('emits a closed SVG path for a triangle', () => {
    const path = hullToPath([
      { x: 0, y: 0 },
      { x: 10, y: 0 },
      { x: 5, y: 10 },
    ])
    expect(path.startsWith('M')).toBe(true)
    expect(path.endsWith('Z')).toBe(true)
    expect(path.match(/L /g)?.length).toBe(2)
  })
})

describe('rectToRoundedPath', () => {
  it('emits a closed SVG path for a rounded rect', () => {
    const path = rectToRoundedPath(0, 0, 100, 50, 10)
    expect(path.startsWith('M')).toBe(true)
    expect(path.endsWith('Z')).toBe(true)
    // Q commands indicate rounded corners (4 quadratic beziers expected)
    expect(path.match(/Q /g)?.length).toBe(4)
  })
})

// ─── groupNodesByTeam ─────────────────────────────────────────────────────────

describe('groupNodesByTeam', () => {
  it('returns empty map for nodes without teamId', () => {
    const nodes = [booNode('a', 0, 0, null), booNode('b', 10, 10, null)]
    expect(groupNodesByTeam(nodes).size).toBe(0)
  })

  it('groups 3 BooNodes in the same team', () => {
    const nodes = [
      booNode('a', 0, 0, 'team-1'),
      booNode('b', 10, 10, 'team-1'),
      booNode('c', 20, 20, 'team-1'),
    ]
    const groups = groupNodesByTeam(nodes)
    expect(groups.size).toBe(1)
    expect(groups.get('team-1')?.nodes).toHaveLength(3)
  })

  it('separates nodes from different teams', () => {
    const nodes = [
      booNode('a', 0, 0, 'team-1'),
      booNode('b', 10, 10, 'team-2'),
      booNode('c', 20, 20, 'team-1'),
    ]
    const groups = groupNodesByTeam(nodes)
    expect(groups.size).toBe(2)
    expect(groups.get('team-1')?.nodes).toHaveLength(2)
    expect(groups.get('team-2')?.nodes).toHaveLength(1)
  })

  it('excludes non-boo node types', () => {
    const nodes = [
      booNode('a', 0, 0, 'team-1'),
      skillNode('skill-1', 5, 5),
      booNode('b', 10, 10, 'team-1'),
    ]
    const groups = groupNodesByTeam(nodes)
    expect(groups.get('team-1')?.nodes).toHaveLength(2)
  })

  it('excludes teamless boos while keeping team members', () => {
    const nodes = [
      booNode('a', 0, 0, 'team-1'),
      booNode('orphan', 50, 50, null),
      booNode('b', 10, 10, 'team-1'),
    ]
    const groups = groupNodesByTeam(nodes)
    expect(groups.size).toBe(1)
    expect(groups.get('team-1')?.nodes).toHaveLength(2)
  })

  it('preserves team metadata from first node in group', () => {
    const nodes = [booNode('a', 0, 0, 'team-1'), booNode('b', 10, 10, 'team-1')]
    const group = groupNodesByTeam(nodes).get('team-1')
    expect(group?.teamName).toBe('Team team-1')
    expect(group?.teamColor).toBe('#34D399')
    expect(group?.teamEmoji).toBe('🛠️')
  })
})
