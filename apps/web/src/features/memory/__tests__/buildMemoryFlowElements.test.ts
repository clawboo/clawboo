// Pure payload → React Flow element builder — hidden-flag propagation is the
// filtering contract (community/scope hide; time/search only dim elsewhere).

import { describe, expect, it } from 'vitest'

import type { MemoryGraphNode, MemoryGraphPayload } from '@/lib/memoryClient'
import { buildMemoryFlowElements, factDiameter } from '../graph/useMemoryGraphData'

function factNode(id: string, overrides: Partial<MemoryGraphNode> = {}): MemoryGraphNode {
  return {
    id,
    kind: 'fact',
    title: `Fact ${id}`,
    content: 'body',
    contentTruncated: false,
    tags: [],
    scope: 'global',
    scopeTeamId: null,
    scopeAgentId: null,
    createdByAgentId: null,
    createdByRuntime: null,
    sourceTaskId: null,
    createdAt: 0,
    updatedAt: 0,
    degree: 0,
    community: 0,
    hasEmbedding: false,
    learning: null,
    ...overrides,
  }
}

const PAYLOAD: MemoryGraphPayload = {
  nodes: [
    factNode('a', { community: 0, degree: 2 }),
    factNode('b', { community: 0, degree: 1, scope: 'team', scopeTeamId: 't1' }),
    factNode('c', { community: 1, degree: 1, scope: 'agent', scopeAgentId: 'ag1' }),
    factNode('p1', { kind: 'procedure', community: 1, version: 3, versionCount: 2 }),
  ],
  edges: [
    { id: 'tag:a:b', source: 'a', target: 'b', kind: 'tag', weight: 0.5, sharedTags: ['x'] },
    { id: 'sim:a:c', source: 'a', target: 'c', kind: 'similarity', weight: 0.8, sharedTags: [] },
  ],
  communities: [
    { id: 0, label: 'x', size: 2 },
    { id: 1, label: 'y', size: 2 },
  ],
  totalFacts: 3,
  totalProcedures: 1,
  truncated: false,
  similarityAvailable: true,
}

const NO_FILTERS = { hiddenCommunities: new Set<number>(), scopeFilter: 'all' as const }

describe('buildMemoryFlowElements', () => {
  it('maps facts to memFact discs and procedures to memProc cards', () => {
    const { nodes } = buildMemoryFlowElements(PAYLOAD, NO_FILTERS)
    const byId = new Map(nodes.map((n) => [n.id, n]))
    expect(byId.get('a')!.type).toBe('memFact')
    expect(byId.get('p1')!.type).toBe('memProc')
    expect(byId.get('p1')!.width).toBe(150)
    expect(byId.get('p1')!.height).toBe(44)
    // Highest-degree fact carries the largest disc.
    expect(byId.get('a')!.width).toBe(factDiameter(2, 2))
    expect(byId.get('b')!.width).toBe(factDiameter(1, 2))
    expect(byId.get('a')!.width!).toBeGreaterThan(byId.get('b')!.width!)
  })

  it('hidden community propagates to nodes AND every edge touching them', () => {
    const { nodes, edges } = buildMemoryFlowElements(PAYLOAD, {
      ...NO_FILTERS,
      hiddenCommunities: new Set([1]),
    })
    const byId = new Map(nodes.map((n) => [n.id, n]))
    expect(byId.get('c')!.hidden).toBe(true)
    expect(byId.get('p1')!.hidden).toBe(true)
    expect(byId.get('a')!.hidden).toBe(false)
    const edgeById = new Map(edges.map((e) => [e.id, e]))
    expect(edgeById.get('sim:a:c')!.hidden).toBe(true) // touches hidden c
    expect(edgeById.get('tag:a:b')!.hidden).toBe(false)
  })

  it('scope filter hides non-matching scopes (and their edges)', () => {
    const { nodes, edges } = buildMemoryFlowElements(PAYLOAD, {
      ...NO_FILTERS,
      scopeFilter: 'team',
    })
    const byId = new Map(nodes.map((n) => [n.id, n]))
    expect(byId.get('b')!.hidden).toBe(false)
    expect(byId.get('a')!.hidden).toBe(true)
    expect(byId.get('c')!.hidden).toBe(true)
    // Both edges touch the hidden 'a'.
    expect(edges.every((e) => e.hidden)).toBe(true)
  })

  it('filters never drop elements — the array shape is layout-stable', () => {
    const all = buildMemoryFlowElements(PAYLOAD, NO_FILTERS)
    const filtered = buildMemoryFlowElements(PAYLOAD, {
      hiddenCommunities: new Set([0, 1]),
      scopeFilter: 'agent',
    })
    expect(filtered.nodes.map((n) => n.id)).toEqual(all.nodes.map((n) => n.id))
    expect(filtered.edges.map((e) => e.id)).toEqual(all.edges.map((e) => e.id))
  })

  it('threads the shared community color onto same-community edges only', () => {
    const { edges } = buildMemoryFlowElements(PAYLOAD, NO_FILTERS)
    const edgeById = new Map(edges.map((e) => [e.id, e]))
    expect(edgeById.get('tag:a:b')!.data!.communityColor).toBe('var(--mem-c0)')
    expect(edgeById.get('sim:a:c')!.data!.communityColor).toBeNull()
  })
})
