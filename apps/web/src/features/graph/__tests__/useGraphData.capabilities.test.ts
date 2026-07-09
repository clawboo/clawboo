// buildGraphElements threads each capability's server-evaluated `available` onto
// the Skill/Resource node data — the signal SkillNode/ResourceNode read to render
// a greyed (grayscale + dimmed) node. Asserts the "greyed in BOTH renderers"
// acceptance from the graph side (the dashboard side is covered by the panel).

import type { CapabilityRecord } from '@clawboo/capability-registry'
import { describe, expect, it } from 'vitest'

import type { AgentState } from '@/stores/fleet'
import type { Team } from '@/stores/team'

import { buildGraphElements } from '../useGraphData'
import type { ResourceNodeData, SkillNodeData } from '../types'

const makeAgent = (over: Partial<AgentState>): AgentState => ({
  id: over.id ?? 'a1',
  name: over.name ?? 'Agent 1',
  status: 'idle',
  sessionKey: null,
  model: null,
  createdAt: null,
  streamingText: null,
  runId: null,
  lastSeenAt: null,
  teamId: over.teamId ?? 't1',
  execConfig: null,
  ...over,
})

const makeTeam = (over: Partial<Team>): Team => ({
  id: over.id ?? 't1',
  name: 'Team 1',
  icon: '🛠️',
  color: '#FBBF24',
  colorCollectionId: null,
  templateId: null,
  agentCount: 0,
  leaderAgentId: null,
  isArchived: false,
  serverOrchestrated: false,
  ...over,
})

const makeCap = (over: Partial<CapabilityRecord>): CapabilityRecord => ({
  id: `native:${over.sourceKey ?? 'x'}`,
  sourceKey: over.sourceKey ?? 'x',
  kind: 'tool',
  runtime: 'clawboo-native',
  scope: 'agent',
  agentId: 'a1',
  source: 'brokered-mcp',
  manageability: 'managed',
  name: over.name ?? 'X',
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

describe('buildGraphElements — capability availability greying', () => {
  it('threads available:false onto BOTH a skill node and a connector (resource) node', () => {
    const agent = makeAgent({ id: 'a1', teamId: 't1' })
    const files = new Map([
      [
        'a1',
        {
          capabilities: [
            makeCap({
              sourceKey: 'web_search',
              kind: 'tool',
              available: false,
              name: 'Web Search',
            }),
            makeCap({
              sourceKey: 'mcp:vendor',
              kind: 'connector',
              available: false,
              name: 'Vendor MCP',
            }),
          ],
          agentsMd: null,
        },
      ],
    ])

    const { rawNodes } = buildGraphElements([agent], files, [makeTeam({ id: 't1' })])
    const skill = rawNodes.find(
      (n) => n.type === 'skill' && (n.data as SkillNodeData).name === 'Web Search',
    )
    const resource = rawNodes.find(
      (n) => n.type === 'resource' && (n.data as ResourceNodeData).name === 'Vendor MCP',
    )

    expect(skill).toBeDefined()
    expect((skill!.data as SkillNodeData).available).toBe(false)
    expect(resource).toBeDefined()
    expect((resource!.data as ResourceNodeData).available).toBe(false)
    // Connector nodes no longer carry an emoji `serviceIcon` — the glyph is a
    // lucide <Plug> rendered by ResourceNode (the lucide-never-emoji rule).
    expect(resource!.data).not.toHaveProperty('serviceIcon')
  })

  it('threads available:true through (an available capability is NOT greyed)', () => {
    const agent = makeAgent({ id: 'a1', teamId: 't1' })
    const files = new Map([
      [
        'a1',
        {
          capabilities: [
            makeCap({ sourceKey: 'echo', kind: 'tool', available: true, name: 'Echo' }),
          ],
          agentsMd: null,
        },
      ],
    ])
    const { rawNodes } = buildGraphElements([agent], files, [makeTeam({ id: 't1' })])
    const skill = rawNodes.find(
      (n) => n.type === 'skill' && (n.data as SkillNodeData).name === 'Echo',
    )
    expect((skill!.data as SkillNodeData).available).toBe(true)
  })
})
