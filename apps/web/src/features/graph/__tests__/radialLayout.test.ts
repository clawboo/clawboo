// The org chart's radial layout is final as computed: the physics relaxes
// nothing on it, with motion or without, so a Boo lands exactly where it is
// placed. These pin the spacing that keeps every Boo, name and thought bubble
// clear of its neighbours.

import { describe, expect, it } from 'vitest'

import {
  ATLAS_RADIAL_BOO_SPACING,
  ATLAS_RADIAL_MAX_FAN_ARC,
  ATLAS_RADIAL_MEMBER_RADIUS,
  ATLAS_RADIAL_TEAM_RADIUS,
  radialFan,
  radialTeamPlacements,
  type RadialPoint,
  type RadialTeamPlacement,
} from '../radialLayout'
import { computeAtlasRadialLayout } from '../useGraphLayout'
import type { GraphNode } from '../types'

const ORIGIN = { x: 0, y: 0 }
/** BOO_ENVELOPE in useGraphLayout: a Boo's node box, its centre the Boo's. */
const ENVELOPE = 280

function dist(a: RadialPoint, b: RadialPoint): number {
  return Math.hypot(a.x - b.x, a.y - b.y)
}

function closestPair(points: readonly RadialPoint[]): number {
  let min = Infinity
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) min = Math.min(min, dist(points[i]!, points[j]!))
  }
  return min
}

/** Boo Zero at the origin, then every member. */
function everyBoo(teams: readonly RadialTeamPlacement[]): RadialPoint[] {
  return [ORIGIN, ...teams.flatMap((t) => t.members)]
}

describe('radialTeamPlacements', () => {
  it.each([
    ['the demo fleet', [5, 3, 3]],
    ['one agent', [1]],
    ['one big team', [12]],
    ['two pairs', [2, 2]],
    ['eight full teams', [5, 5, 5, 5, 5, 5, 5, 5]],
    ['a big team among singles', [9, 1, 1, 1]],
    ['twelve pairs', Array.from({ length: 12 }, () => 2)],
  ])('keeps every two Boos the spacing apart: %s', (_label, sizes) => {
    const teams = radialTeamPlacements(sizes)
    expect(teams.map((t) => t.members.length)).toEqual(sizes)
    expect(closestPair(everyBoo(teams))).toBeGreaterThanOrEqual(ATLAS_RADIAL_BOO_SPACING - 1e-6)
  })

  it('opens every fan away from Boo Zero', () => {
    for (const team of radialTeamPlacements([5, 3, 3, 1])) {
      for (const m of team.members) {
        expect(dist(m, ORIGIN)).toBeGreaterThan(dist(team.junction, ORIGIN))
      }
    }
  })

  it('keeps small teams on the default ring and radius', () => {
    const [, support, platform] = radialTeamPlacements([5, 3, 3])
    for (const team of [support!, platform!]) {
      expect(dist(team.junction, ORIGIN)).toBeCloseTo(ATLAS_RADIAL_TEAM_RADIUS)
      for (const m of team.members) {
        expect(dist(m, team.junction)).toBeCloseTo(ATLAS_RADIAL_MEMBER_RADIUS)
      }
    }
  })

  it("pushes a big team's fan out once it is as wide as a fan opens", () => {
    expect(radialFan(3)).toEqual({ radius: ATLAS_RADIAL_MEMBER_RADIUS, arc: expect.any(Number) })
    const big = radialFan(5)
    expect(big.arc).toBeCloseTo(ATLAS_RADIAL_MAX_FAN_ARC)
    expect(big.radius).toBeGreaterThan(ATLAS_RADIAL_MEMBER_RADIUS)
  })

  it('widens the ring of teams when their fans would meet', () => {
    const [first] = radialTeamPlacements([5, 5, 5, 5, 5, 5, 5, 5])
    expect(dist(first!.junction, ORIGIN)).toBeGreaterThan(ATLAS_RADIAL_TEAM_RADIUS)
  })
})

describe('computeAtlasRadialLayout', () => {
  function boo(id: string, teamId: string | null, extra: Record<string, unknown> = {}): GraphNode {
    return {
      id: `boo-${id}`,
      type: 'boo',
      position: { x: 0, y: 0 },
      data: { agentId: id, name: id, teamId, ...extra },
    } as unknown as GraphNode
  }
  function root(teamId: string): GraphNode {
    return {
      id: `team-root-${teamId}`,
      type: 'team-root',
      position: { x: 0, y: 0 },
      data: { teamId },
    } as unknown as GraphNode
  }

  // The demo seed: Growth has five, Support and Platform three each.
  const TEAMS = { growth: 5, support: 3, platform: 3 }
  const nodes: GraphNode[] = [boo('zero', null, { isUniversalLeader: true })]
  for (const [teamId, size] of Object.entries(TEAMS)) {
    nodes.push(root(teamId))
    for (let i = 0; i < size; i++) nodes.push(boo(`${teamId}-${i}`, teamId))
  }

  it('lays the demo fleet out with no two Boos closer than the spacing', async () => {
    const out = await computeAtlasRadialLayout(nodes, [], {}, Object.keys(TEAMS))
    const centers = out
      .filter((n) => n.type === 'boo')
      .map((n) => ({ x: n.position.x + ENVELOPE / 2, y: n.position.y + ENVELOPE / 2 }))
    expect(centers).toHaveLength(12)
    expect(closestPair(centers)).toBeGreaterThanOrEqual(ATLAS_RADIAL_BOO_SPACING - 1e-6)
  })

  it("puts each team's junction where its fan hangs from", async () => {
    const out = await computeAtlasRadialLayout(nodes, [], {}, Object.keys(TEAMS))
    const placements = radialTeamPlacements(Object.values(TEAMS))
    Object.keys(TEAMS).forEach((teamId, i) => {
      const junction = out.find((n) => n.id === `team-root-${teamId}`)!.position
      expect(junction.x).toBeCloseTo(placements[i]!.junction.x)
      expect(junction.y).toBeCloseTo(placements[i]!.junction.y)
    })
  })
})
