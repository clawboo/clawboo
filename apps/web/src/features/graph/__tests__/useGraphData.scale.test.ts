// Scale. `buildGraphElements` runs on every inventory refresh and every fleet
// change, on the main thread, so its cost is felt as interface lag rather than
// as a slow number in a report.
//
// The assertions are deliberately loose. A tight millisecond budget on shared CI
// is a flaky test that gets deleted, and the failure this guards against is not
// "3ms slower" -- it is someone reintroducing quadratic work over capabilities,
// which shows up as orders of magnitude.

import type { CapabilityRecord } from '@clawboo/capability-registry'
import { describe, expect, it } from 'vitest'

import type { AgentState } from '@/stores/fleet'
import type { Team } from '@/stores/team'

import { ATLAS_ORBITAL_CEILING, buildGraphElements } from '../useGraphData'

function agents(n: number): AgentState[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `a${i}`,
    name: `Agent ${i}`,
    status: 'idle' as const,
    sessionKey: null,
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId: `t${i % 10}`,
    execConfig: null,
  }))
}

function teams(n: number): Team[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `t${i}`,
    name: `Team ${i}`,
    icon: '🛠️',
    color: '#FBBF24',
    colorCollectionId: null,
    templateId: null,
    agentCount: 0,
    leaderAgentId: null,
    isArchived: false,
    serverOrchestrated: false,
  }))
}

function caps(agentId: string, n: number): CapabilityRecord[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `native:${agentId}:s${i}`,
    sourceKey: `s${i}`,
    kind: (i % 3 === 0 ? 'connector' : 'skill') as CapabilityRecord['kind'],
    runtime: 'clawboo-native',
    scope: 'agent' as const,
    agentId,
    source: 'curated-skill' as const,
    manageability: 'managed' as const,
    name: `Cap ${i}`,
    description: '',
    availability: null,
    available: true,
    diagnostics: [],
    provenance: null,
    status: 'ready' as const,
    tenantId: null,
    syncedAt: '2026-01-01T00:00:00.000Z',
  }))
}

function build(agentCount: number, capsPer: number) {
  const list = agents(agentCount)
  const files = new Map(
    list.map((a) => [a.id, { capabilities: caps(a.id, capsPer), agentsMd: null }]),
  )
  const started = performance.now()
  // ATLAS scope: this suite is about the all-teams view, which is the only place
  // node count is a real cost and therefore the only place a ceiling applies.
  const out = buildGraphElements(list, files, teams(10), null, null, null, 'atlas')
  return { ...out, ms: performance.now() - started }
}

describe('buildGraphElements at scale', () => {
  it('handles 300 agents with 40 capabilities each', () => {
    const { rawNodes, ms } = build(300, 40)
    expect(rawNodes.length).toBeGreaterThan(0)
    // Orders of magnitude, not milliseconds: this catches quadratic work, not a
    // regression of a few percent.
    expect(ms).toBeLessThan(5_000)
  })

  it('node count stays bounded in ATLAS, however many capabilities an agent has', () => {
    // A focused view draws every capability, because one Boo has room. Atlas cannot:
    // its cost is node count across every agent at once, so 40 capabilities and 400
    // must produce the same number of tiles or a single large MCP server makes the
    // all-teams view unrenderable.
    const small = build(50, 10)
    const huge = build(50, 400)
    const orbitalsOf = (nodes: { type?: string }[]) =>
      nodes.filter((n) => n.type === 'skill' || n.type === 'resource').length

    expect(orbitalsOf(huge.rawNodes)).toBeLessThanOrEqual(
      // ceiling + the model tile + the overflow tile, per agent
      50 * (ATLAS_ORBITAL_CEILING + 2),
    )
    expect(orbitalsOf(huge.rawNodes)).toBeGreaterThan(orbitalsOf(small.rawNodes) - 50)
  })

  it('produces no duplicate node ids at scale', () => {
    // A duplicate id makes React Flow drop a node silently, which at this size
    // is invisible by inspection.
    const { rawNodes } = build(300, 40)
    const ids = new Set(rawNodes.map((n) => n.id))
    expect(ids.size).toBe(rawNodes.length)
  })

  it('every edge points at a node that exists', () => {
    // A dangling edge renders as a line to nowhere and is the classic symptom of
    // a capped list whose edges were not capped with it.
    const { rawNodes, rawEdges } = build(100, 40)
    const ids = new Set(rawNodes.map((n) => n.id))
    for (const edge of rawEdges) {
      expect(ids.has(edge.source), `source ${edge.source}`).toBe(true)
      expect(ids.has(edge.target), `target ${edge.target}`).toBe(true)
    }
  })
})
