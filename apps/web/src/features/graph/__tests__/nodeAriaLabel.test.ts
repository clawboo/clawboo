// Accessible names for graph nodes. React Flow makes every node a Tab stop and
// reads `node.ariaLabel`; nothing set one, so a screen reader announced a bare
// "group, node" for every Boo, capability and connector on the canvas.

import { describe, expect, it } from 'vitest'

import { graphNodeAriaLabel } from '../nodeAriaLabel'
import type { GraphNode } from '../types'

function boo(data: Partial<GraphNode['data']> = {}): GraphNode {
  return {
    id: 'boo-a1',
    type: 'boo',
    position: { x: 0, y: 0 },
    data: {
      agentId: 'a1',
      name: 'Scout',
      status: 'idle',
      model: null,
      runtime: null,
      isStreaming: false,
      teamId: null,
      ...data,
    },
  } as GraphNode
}

function skill(data: Record<string, unknown> = {}): GraphNode {
  return {
    id: 'skill-a1-web',
    type: 'skill',
    position: { x: 0, y: 0 },
    data: {
      skillId: 'web-search',
      name: 'Web search',
      category: 'web',
      description: null,
      agentIds: ['a1'],
      ...data,
    },
  } as GraphNode
}

function resource(data: Record<string, unknown> = {}): GraphNode {
  return {
    id: 'resource-a1-memory',
    type: 'resource',
    position: { x: 0, y: 0 },
    data: { resourceId: 'memory', name: 'Memory', agentIds: ['a1'], ...data },
  } as GraphNode
}

describe('graphNodeAriaLabel', () => {
  it('names a Boo with its status and team', () => {
    expect(graphNodeAriaLabel(boo({ teamName: 'Research Lab' }))).toBe(
      'Agent Scout, idle, team Research Lab',
    )
  })

  it('reports the live status, not a fixed one', () => {
    expect(graphNodeAriaLabel(boo({ status: 'running' }))).toContain('running')
    expect(graphNodeAriaLabel(boo({ status: 'error' }))).toContain('error')
  })

  it('calls out Boo Zero as the universal leader', () => {
    expect(graphNodeAriaLabel(boo({ isUniversalLeader: true, teamName: 'X' }))).toBe(
      'Agent Scout, idle, universal leader',
    )
  })

  it('says so when a Boo has no team', () => {
    expect(graphNodeAriaLabel(boo())).toBe('Agent Scout, idle, no team')
  })

  it('names a capability, and flags disabled / unavailable ones', () => {
    expect(graphNodeAriaLabel(skill())).toBe('Capability Web search')
    expect(graphNodeAriaLabel(skill({ available: false }))).toBe(
      'Capability Web search, unavailable',
    )
    expect(graphNodeAriaLabel(skill({ enabled: false }))).toBe('Capability Web search, disabled')
  })

  // The two synthesized orbitals are not capabilities and must not read as such.
  it('distinguishes the synthesized leadership and model orbitals', () => {
    expect(graphNodeAriaLabel(skill({ isLeadership: true }))).toBe(
      'Leadership, reserved capability of Boo Zero',
    )
    expect(graphNodeAriaLabel(skill({ isModel: true, name: 'claude-opus-5' }))).toBe(
      'Model, claude-opus-5',
    )
  })

  it('reads a capability by the name on its tile, not its raw key', () => {
    expect(graphNodeAriaLabel(skill({ name: 'web_search', displayName: 'Web Search' }))).toBe(
      'Capability Web Search',
    )
  })

  it('names a group by what it holds', () => {
    expect(
      graphNodeAriaLabel(
        skill({ name: '41 plugins', group: { cls: 'plugin', members: [], runtime: 'openclaw' } }),
      ),
    ).toBe('Group, 41 plugins')
  })

  it('names a connector', () => {
    expect(graphNodeAriaLabel(resource())).toBe('Connector Memory')
    expect(graphNodeAriaLabel(resource({ enabled: false }))).toBe('Connector Memory, disabled')
  })

  it('does not call an OpenClaw plugin a connector', () => {
    expect(graphNodeAriaLabel(resource({ name: 'Device Pair', serviceKind: 'plugin' }))).toBe(
      'Plugin Device Pair',
    )
  })

  // Team-root junctions are 1px and invisible; GhostGraph also marks them
  // `focusable: false`, so they never need a name.
  it('leaves the invisible team-root junction unnamed', () => {
    const teamRoot = {
      id: 'team-root-t1',
      type: 'team-root',
      position: { x: 0, y: 0 },
      data: { teamId: 't1' },
    } as GraphNode
    expect(graphNodeAriaLabel(teamRoot)).toBeUndefined()
  })
})
