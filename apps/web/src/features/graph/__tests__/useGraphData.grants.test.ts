// The connector-era threading: buildGraphElements carries the optional grant /
// health fields from a CapabilityRecord onto the resource node, keys the node on
// the connector INSTANCE id when one exists, and renders a grant-backed record's
// edge as a `grant` edge, while a record that has never heard of grants renders
// byte-identically to the pre-grant graph. That backward-compat half is the
// load-bearing assertion: prod servers emit none of these fields today, so any
// visual change without them is a regression.

import type { CapabilityRecord } from '@clawboo/capability-registry'
import { describe, expect, it } from 'vitest'

import type { AgentState } from '@/stores/fleet'
import type { Team } from '@/stores/team'

import { buildGraphElements } from '../useGraphData'
import type { ResourceNodeData } from '../types'

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

const makeConnectorCap = (over: Partial<CapabilityRecord>): CapabilityRecord => ({
  id: `native:${over.sourceKey ?? 'mcp:x'}`,
  sourceKey: over.sourceKey ?? 'mcp:x',
  kind: 'connector',
  runtime: 'clawboo-native',
  scope: 'agent',
  agentId: 'a1',
  source: 'mcp-connector',
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

function build(caps: CapabilityRecord[]) {
  const agent = makeAgent({ id: 'a1', teamId: 't1' })
  const files = new Map([['a1', { capabilities: caps, agentsMd: null }]])
  return buildGraphElements([agent], files, [makeTeam({ id: 't1' })])
}

describe('buildGraphElements: grant-era threading', () => {
  it('renders a LEGACY record (no grant fields) byte-identically to the pre-grant graph', () => {
    const { rawNodes, rawEdges } = build([
      makeConnectorCap({ sourceKey: 'mcp:memory', name: 'clawboo-memory' }),
    ])

    const node = rawNodes.find((n) => n.type === 'resource')
    expect(node).toBeDefined()
    // Slug-keyed id, exactly as before the connector era.
    expect(node!.id).toBe('resource-a1-mcp-memory')
    const data = node!.data as ResourceNodeData
    expect(data.connectorId).toBeNull()
    expect(data.grantIds).toBeUndefined()

    // The edge stays a plain resource edge: no grant, no grant rendering.
    const edge = rawEdges.find((e) => e.target === node!.id)
    expect(edge?.type).toBe('resource')
  })

  it('keys the node on the connector INSTANCE id when one exists (rename-stable identity)', () => {
    const { rawNodes } = build([
      makeConnectorCap({
        sourceKey: 'mcp:github-work',
        name: 'GitHub (work)',
        connectorId: 'conn_abc123',
      }),
    ])
    const node = rawNodes.find((n) => n.type === 'resource')
    // A rename changes the slug but not the instance id: the node id (and with
    // it the user's hand-placed position) survives.
    expect(node!.id).toBe('resource-a1-conn_abc123')
    expect((node!.data as ResourceNodeData).connectorId).toBe('conn_abc123')
  })

  it('renders a grant-backed record with a GRANT edge carrying the grant id', () => {
    const { rawNodes, rawEdges } = build([
      makeConnectorCap({
        sourceKey: 'mcp:github',
        name: 'GitHub',
        connectorId: 'conn_abc123',
        grantId: 'grant_def456',
      }),
    ])
    const node = rawNodes.find((n) => n.type === 'resource')
    expect((node!.data as ResourceNodeData).grantIds).toEqual(['grant_def456'])

    const edge = rawEdges.find((e) => e.target === node!.id)
    expect(edge?.type).toBe('grant')
    expect(edge?.data).toMatchObject({ grantId: 'grant_def456', state: 'active', mode: 'read' })
  })

  it('threads health, diagnostics, hint, grantCount and lastUsedAt onto the node', () => {
    const { rawNodes } = build([
      makeConnectorCap({
        sourceKey: 'mcp:linear',
        name: 'Linear',
        connectorId: 'conn_lin',
        health: 'needs-auth',
        healthDetail: 'token expired',
        diagnostics: ['auth-missing:linear'],
        hint: 'Sign in from the connector tile',
        grantCount: 2,
        lastUsedAt: '2026-08-01T00:00:00.000Z',
      }),
    ])
    const data = rawNodes.find((n) => n.type === 'resource')!.data as ResourceNodeData
    expect(data.health).toBe('needs-auth')
    expect(data.healthDetail).toBe('token expired')
    expect(data.diagnostics).toEqual(['auth-missing:linear'])
    expect(data.hint).toBe('Sign in from the connector tile')
    expect(data.grantCount).toBe(2)
    expect(data.lastUsedAt).toBe(Date.parse('2026-08-01T00:00:00.000Z'))
  })

  it('omits empty diagnostics rather than threading an empty array', () => {
    const { rawNodes } = build([makeConnectorCap({ sourceKey: 'mcp:x', name: 'X' })])
    const data = rawNodes.find((n) => n.type === 'resource')!.data as ResourceNodeData
    expect(data.diagnostics).toBeUndefined()
  })
})
