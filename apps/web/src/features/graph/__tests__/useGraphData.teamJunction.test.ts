import { describe, expect, it } from 'vitest'

import type { AgentState } from '@/stores/fleet'
import type { Team } from '@/stores/team'

import type { GraphEdge } from '../types'
import { buildGraphElements } from '../useGraphData'

// Where a team hangs off Boo Zero, the chart wears the team's badge: Atlas on
// each team's junction node, a team's own graph on the edge that splits into
// the team. These pin which edges carry that mark, so the badge lands once per
// team and never on an edge that is not the team's link to Boo Zero.

const agent = (id: string, teamId: string | null): AgentState =>
  ({
    id,
    name: id,
    status: 'idle',
    sessionKey: null,
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId,
    execConfig: null,
  }) as AgentState

const team = (id: string): Team => ({
  id,
  name: `Team ${id}`,
  icon: '🚀',
  color: '#e94560',
  colorCollectionId: null,
  templateId: null,
  agentCount: 0,
  leaderAgentId: null,
  isArchived: false,
  serverOrchestrated: false,
})

const booZero = agent('bz', null)
const junctionOf = (e: GraphEdge) => (e.data as { teamJunction?: string }).teamJunction

describe('team junction marks', () => {
  it("tags every Boo Zero edge into a leaderless team, and one of them draws the team's trunk", () => {
    const m1 = agent('m1', 't1')
    const m2 = agent('m2', 't1')
    const { rawEdges } = buildGraphElements(
      [m1, m2, booZero],
      new Map(),
      [team('t1')],
      null,
      booZero,
      't1',
      'team',
    )
    const marked = rawEdges.filter((e) => junctionOf(e) === 't1')
    expect(marked.map((e) => e.id).sort()).toEqual(['dep-syn-bz-m1', 'dep-syn-bz-m2'])
    // Exactly one marked edge leads the shared trunk, so the badge is drawn once
    // at the split rather than once per member.
    const leaders = marked.filter((e) => (e.data as { isTrunkLeader?: boolean }).isTrunkLeader)
    expect(leaders).toHaveLength(1)
  })

  it('tags only the Boo Zero edge into a team led by its own lead', () => {
    const lead = agent('lead', 't1')
    const m1 = agent('m1', 't1')
    const { rawEdges } = buildGraphElements(
      [lead, m1, booZero],
      new Map(),
      [team('t1')],
      'lead',
      booZero,
      't1',
      'team',
    )
    expect(rawEdges.filter((e) => junctionOf(e)).map((e) => e.id)).toEqual(['dep-syn-bz-lead'])
  })

  it('leaves Atlas edges unmarked, because Atlas draws the badge on the junction node', () => {
    const m1 = agent('m1', 't1')
    const { rawEdges, rawNodes } = buildGraphElements(
      [m1, booZero],
      new Map(),
      [team('t1')],
      null,
      booZero,
      null,
      'atlas',
      new Map([['t1', null]]),
    )
    expect(rawEdges.some((e) => junctionOf(e))).toBe(false)
    expect(rawNodes.some((n) => n.type === 'team-root')).toBe(true)
  })
})
