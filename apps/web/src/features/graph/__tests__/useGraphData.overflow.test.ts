// The orbital ring holds a fixed number of tiles. What matters is not the cap
// itself but that nothing disappears silently: the count on the ring has to add
// up to what the agent actually has.

import type { CapabilityRecord } from '@clawboo/capability-registry'
import { describe, expect, it } from 'vitest'

import type { AgentState } from '@/stores/fleet'
import type { Team } from '@/stores/team'

import {
  ATLAS_ORBITAL_CEILING,
  buildGraphElements,
  COMFORTABLE_ORBITAL_COUNT,
} from '../useGraphData'
import type { SkillNodeData } from '../types'

const agent = (): AgentState => ({
  id: 'a1',
  name: 'Agent 1',
  status: 'idle',
  sessionKey: null,
  model: null,
  createdAt: null,
  streamingText: null,
  runId: null,
  lastSeenAt: null,
  teamId: 't1',
  execConfig: null,
})

const team = (): Team => ({
  id: 't1',
  name: 'Team 1',
  icon: '🛠️',
  color: '#FBBF24',
  colorCollectionId: null,
  templateId: null,
  agentCount: 0,
  leaderAgentId: null,
  isArchived: false,
  serverOrchestrated: false,
})

const cap = (over: Partial<CapabilityRecord>): CapabilityRecord => ({
  id: `native:${over.sourceKey ?? 'k'}`,
  sourceKey: over.sourceKey ?? 'k',
  kind: 'skill',
  runtime: 'clawboo-native',
  scope: 'agent',
  agentId: 'a1',
  source: 'curated-skill',
  manageability: 'managed',
  name: over.name ?? 'S',
  description: '',
  availability: null,
  available: true,
  diagnostics: [],
  provenance: null,
  status: 'ready',
  tenantId: null,
  syncedAt: '2026-01-01T00:00:00.000Z',
  ...over,
})

function build(caps: CapabilityRecord[]) {
  return buildGraphElements([agent()], new Map([['a1', { capabilities: caps, agentsMd: null }]]), [
    team(),
  ])
}

describe('orbital overflow', () => {
  it('renders every capability when there is room', () => {
    const caps = Array.from({ length: COMFORTABLE_ORBITAL_COUNT }, (_, i) =>
      cap({ sourceKey: `s${i}`, name: `S${i}` }),
    )
    const { rawNodes } = build(caps)
    // Every Boo also carries a fixed "Default model" tile, which is not a
    // capability and sits outside the budget.
    const skills = rawNodes.filter(
      (n) => n.type === 'skill' && (n.data as SkillNodeData).skillId !== 'clawboo-model',
    )
    expect(skills).toHaveLength(COMFORTABLE_ORBITAL_COUNT)
    expect(skills.some((n) => (n.data as SkillNodeData).overflowCount)).toBe(false)
  })

  it('draws EVERY capability in a focused view, past the comfortable ring size', () => {
    // The ring used to stop at eight everywhere and roll the rest into "+N more", so
    // an agent on a large MCP server showed eight of its forty abilities. The canvas
    // is infinite; the ring is what has to grow, which it now does.
    const caps = Array.from({ length: 20 }, (_, i) => cap({ sourceKey: `s${i}`, name: `S${i}` }))
    const { rawNodes } = build(caps)
    const skills = rawNodes.filter(
      (n) => n.type === 'skill' && (n.data as SkillNodeData).skillId !== 'clawboo-model',
    )

    expect(skills).toHaveLength(20)
    expect(skills.some((n) => (n.data as SkillNodeData).overflowCount)).toBe(false)
    expect(skills.some((n) => String((n.data as SkillNodeData).name).includes('more'))).toBe(false)
  })

  it('still bounds the ALL-TEAMS view, and accounts for what it cut', () => {
    // Atlas pays in node count across every agent at once, which no radius growth
    // fixes. It keeps a ceiling until grouped orbitals land, and the overflow tile
    // has to say how many are behind it or the ring is quietly lying.
    const caps = Array.from({ length: ATLAS_ORBITAL_CEILING + 6 }, (_, i) =>
      cap({ sourceKey: `s${i}`, name: `S${i}` }),
    )
    const { rawNodes } = buildGraphElements(
      [agent()],
      new Map([['a1', { capabilities: caps, agentsMd: null }]]),
      [team()],
      null,
      null,
      null,
      'atlas',
    )
    const skills = rawNodes.filter(
      (n) => n.type === 'skill' && (n.data as SkillNodeData).skillId !== 'clawboo-model',
    )
    expect(skills).toHaveLength(ATLAS_ORBITAL_CEILING + 1)
    const more = skills.find((n) => (n.data as SkillNodeData).overflowCount)
    expect((more!.data as SkillNodeData).overflowCount).toBe(6)
  })

  it('keeps the tiles that NEED attention, and cuts ordinary ones first', () => {
    // A tile the operator has to act on is worthless if it is the one that got
    // cut, so ranking is by what needs seeing rather than by name.
    const caps = [
      ...Array.from({ length: 12 }, (_, i) => cap({ sourceKey: `plain${i}`, name: `Plain${i}` })),
      cap({ sourceKey: 'drifted', name: 'Drifted', kind: 'connector', health: 'drift' }),
      cap({ sourceKey: 'noauth', name: 'NeedsAuth', kind: 'connector', health: 'needs-auth' }),
      cap({ sourceKey: 'broken', name: 'Unavailable', available: false }),
    ]
    const { rawNodes } = build(caps)
    const names = rawNodes
      .filter((n) => n.type === 'skill' || n.type === 'resource')
      .map((n) => (n.data as { name: string }).name)

    expect(names).toContain('Drifted')
    expect(names).toContain('NeedsAuth')
    expect(names).toContain('Unavailable')
  })

  it('links the overflow tile to its Boo like any other orbital', () => {
    // Only Atlas produces an overflow tile now, and it still needs its edge: without
    // one the tile floats free of its agent and the physics has no parent to spring
    // it toward.
    const caps = Array.from({ length: ATLAS_ORBITAL_CEILING + 4 }, (_, i) =>
      cap({ sourceKey: `s${i}` }),
    )
    const { rawEdges } = buildGraphElements(
      [agent()],
      new Map([['a1', { capabilities: caps, agentsMd: null }]]),
      [team()],
      null,
      null,
      null,
      'atlas',
    )
    const edge = rawEdges.find((e) => e.id === 'skilledge-a1-more')
    expect(edge?.source).toBe('boo-a1')
  })
})
