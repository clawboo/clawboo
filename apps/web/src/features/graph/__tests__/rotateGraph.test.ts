import { describe, expect, it } from 'vitest'

import {
  FOCUS_CLEARANCE,
  FOCUS_PULL,
  FOCUS_PUSH,
  planTeamRotation,
  focusedTeamPose,
  posedPositions,
  rotatePoint,
  rotatedPositions,
  shortestTurn,
  teamRestSnapshot,
  withOrbitals,
} from '../rotateGraph'
import type { GraphEdge, GraphNode } from '../types'

const BOO = 280

function boo(id: string, cx: number, cy: number, extra: Record<string, unknown> = {}): GraphNode {
  return {
    id,
    type: 'boo',
    position: { x: cx - BOO / 2, y: cy - BOO / 2 },
    measured: { width: BOO, height: BOO },
    data: { ...extra },
  } as unknown as GraphNode
}

function root(teamId: string, cx: number, cy: number): GraphNode {
  return {
    id: `team-root-${teamId}`,
    type: 'team-root',
    position: { x: cx, y: cy },
    data: { teamId },
  } as unknown as GraphNode
}

describe('rotateGraph', () => {
  it('rotates a point clockwise on screen for a positive angle', () => {
    const p = rotatePoint({ x: 10, y: 0 }, { x: 0, y: 0 }, Math.PI / 2)
    expect(p.x).toBeCloseTo(0)
    expect(p.y).toBeCloseTo(10)
  })

  it('takes the short way round', () => {
    expect(shortestTurn(0, Math.PI / 2)).toBeCloseTo(Math.PI / 2)
    expect(shortestTurn(Math.PI * 0.9, -Math.PI * 0.9)).toBeCloseTo(Math.PI * 0.2)
    expect(shortestTurn(-Math.PI / 2, 0)).toBeCloseTo(Math.PI / 2)
  })

  it('plans the turn that brings a team to the right of Boo Zero', () => {
    const nodes = [
      boo('bz', 0, 0, { isUniversalLeader: true }),
      root('north', 0, -600),
      root('west', -600, 0),
    ]
    // North (straight up) turns a quarter clockwise; west turns half way.
    expect(planTeamRotation(nodes, 'north')?.turn).toBeCloseTo(Math.PI / 2)
    expect(Math.abs(planTeamRotation(nodes, 'west')!.turn)).toBeCloseTo(Math.PI)
    expect(planTeamRotation(nodes, 'missing')).toBeNull()
  })

  it('turns every node around the hinge and keeps Boo Zero still', () => {
    const nodes = [
      boo('bz', 0, 0, { isUniversalLeader: true }),
      root('north', 0, -600),
      boo('ada', 0, -920, { teamId: 'north' }),
    ]
    const plan = planTeamRotation(nodes, 'north')!
    const from = new Map(nodes.map((n) => [n.id, n.position]))
    const next = rotatedPositions(nodes, from, plan.pivot, plan.turn)

    expect(next.get('bz')!.x).toBeCloseTo(-BOO / 2)
    expect(next.get('bz')!.y).toBeCloseTo(-BOO / 2)
    // The junction now sits straight right of Boo Zero, and the member beyond it.
    expect(next.get('team-root-north')!.x).toBeCloseTo(600)
    expect(next.get('team-root-north')!.y).toBeCloseTo(0)
    expect(next.get('ada')!.x + BOO / 2).toBeCloseTo(920)
    expect(next.get('ada')!.y + BOO / 2).toBeCloseTo(0)
  })

  it('poses a focused agent ahead and parts the rest around its line', () => {
    const nodes = [
      boo('bz', 0, 0, { isUniversalLeader: true }),
      root('east', 600, 0),
      // As the physics leaves them: one above the line, one on it, one below.
      boo('a1', 880, -220, { teamId: 'east' }),
      boo('a2', 940, 0, { teamId: 'east' }),
      boo('a3', 880, 220, { teamId: 'east' }),
      root('west', -600, 0),
    ]
    const rest = teamRestSnapshot(nodes, 'east')
    expect([...rest.keys()].sort()).toEqual(['a1', 'a2', 'a3', 'team-root-east'])
    const centre = (p: { x: number; y: number }) => ({ x: p.x + BOO / 2, y: p.y + BOO / 2 })

    // Focus the one at the bottom: the one on the line must step aside.
    const pose = focusedTeamPose(nodes, 'east', 'a3', rest)!
    const junction = pose.get('team-root-east')!
    // The edge from Boo Zero shortens: the junction draws back.
    expect(junction.x).toBeCloseTo(600 - FOCUS_PULL)
    expect(junction.y).toBeCloseTo(0)
    // The focused agent steps out straight ahead, past the team's old reach.
    expect(centre(pose.get('a3')!).x).toBeCloseTo(600 + 320 + FOCUS_PUSH)
    expect(centre(pose.get('a3')!).y).toBeCloseTo(0)
    // Nobody else sits on its line, and each keeps its distance from the junction.
    for (const id of ['a1', 'a2']) {
      const c = centre(pose.get(id)!)
      expect(Math.abs(c.y)).toBeGreaterThanOrEqual(FOCUS_CLEARANCE - 0.5)
      const restC = centre(rest.get(id)!)
      expect(Math.hypot(c.x - junction.x, c.y - junction.y)).toBeCloseTo(
        Math.hypot(restC.x - 600, restC.y),
      )
    }
    // They part to opposite sides.
    expect(Math.sign(centre(pose.get('a1')!).y)).not.toBe(Math.sign(centre(pose.get('a2')!).y))
    // Other teams are not part of the pose.
    expect(pose.has('team-root-west')).toBe(false)
  })

  it('keeps a side that already clears the line where it was, only drawn back', () => {
    const nodes = [
      boo('bz', 0, 0, { isUniversalLeader: true }),
      root('east', 600, 0),
      boo('a1', 880, -220, { teamId: 'east' }),
      boo('a2', 940, 0, { teamId: 'east' }),
    ]
    const rest = teamRestSnapshot(nodes, 'east')
    const pose = focusedTeamPose(nodes, 'east', 'a2', rest)!
    // a1 already clears the line: it only slides back with the junction.
    expect(pose.get('a1')!.x).toBeCloseTo(rest.get('a1')!.x - FOCUS_PULL)
    expect(pose.get('a1')!.y).toBeCloseTo(rest.get('a1')!.y)
  })

  it('blends a move and a turn frame by frame', () => {
    const nodes = [root('t', 100, 0)]
    const from = new Map([['team-root-t', { x: 100, y: 0 }]])
    const to = new Map([['team-root-t', { x: 200, y: 0 }]])
    expect(posedPositions(nodes, from, to, null, 0, 0.5).get('team-root-t')).toEqual({
      x: 150,
      y: 0,
    })
    const turned = posedPositions(nodes, from, to, { x: 0, y: 0 }, Math.PI, 1).get('team-root-t')!
    expect(turned.x).toBeCloseTo(-200)
    expect(turned.y).toBeCloseTo(0)
  })

  it("carries a moved Boo's tiles along with it", () => {
    const edges = [
      { id: 'e1', source: 'ada', target: 'skill-ada-x', type: 'skill' },
      { id: 'e2', source: 'bea', target: 'skill-bea-y', type: 'skill' },
    ] as unknown as GraphEdge[]
    const from = new Map([
      ['ada', { x: 0, y: 0 }],
      ['skill-ada-x', { x: 50, y: 10 }],
      ['bea', { x: 500, y: 0 }],
      ['skill-bea-y', { x: 550, y: 10 }],
    ])
    const to = withOrbitals(edges, from, new Map([['ada', { x: 100, y: -20 }]]))
    expect(to.get('skill-ada-x')).toEqual({ x: 150, y: -10 })
    expect(to.has('skill-bea-y')).toBe(false)
  })
})
