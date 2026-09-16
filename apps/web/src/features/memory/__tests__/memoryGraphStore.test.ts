// Memory graph store — hover cascade, filter set semantics, intensity math,
// and the reset guarantee (stale selections must never leak across visits).

import { beforeEach, describe, expect, it } from 'vitest'

import type { MemoryGraphNode, MemoryGraphPayload } from '@/lib/memoryClient'
import { computeNodeIntensity, useMemoryGraphStore } from '../graph/store'

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

function payloadOf(
  nodes: MemoryGraphNode[],
  edges: MemoryGraphPayload['edges'],
): MemoryGraphPayload {
  return {
    nodes,
    edges,
    communities: [{ id: 0, label: 'untagged', size: nodes.length }],
    totalFacts: nodes.length,
    totalProcedures: 0,
    truncated: false,
    similarityAvailable: false,
  }
}

const PAYLOAD = payloadOf(
  [factNode('a'), factNode('b'), factNode('c')],
  [{ id: 'tag:a:b', source: 'a', target: 'b', kind: 'tag', weight: 0.5, sharedTags: ['x'] }],
)

beforeEach(() => useMemoryGraphStore.getState().reset())

describe('useMemoryGraphStore', () => {
  it('hover cascade highlights the node + its adjacency; leaving clears it', () => {
    const store = useMemoryGraphStore.getState()
    store.setPayload(PAYLOAD, null)
    useMemoryGraphStore.getState().setHovered('a')
    let s = useMemoryGraphStore.getState()
    expect(s.hoveredNodeId).toBe('a')
    expect([...s.highlightedNodeIds!].sort()).toEqual(['a', 'b'])

    useMemoryGraphStore.getState().setHovered(null)
    s = useMemoryGraphStore.getState()
    expect(s.hoveredNodeId).toBeNull()
    expect(s.highlightedNodeIds).toBeNull()
  })

  it('toggleCommunity has set semantics (add / remove, fresh Set identity)', () => {
    const store = useMemoryGraphStore.getState()
    store.toggleCommunity(2)
    const first = useMemoryGraphStore.getState().hiddenCommunities
    expect(first.has(2)).toBe(true)
    useMemoryGraphStore.getState().toggleCommunity(2)
    const second = useMemoryGraphStore.getState().hiddenCommunities
    expect(second.has(2)).toBe(false)
    expect(second).not.toBe(first)
  })

  it('setPayload bumps payloadVersion and clears id-keyed interaction state', () => {
    const store = useMemoryGraphStore.getState()
    store.setPayload(PAYLOAD, null)
    useMemoryGraphStore.getState().select('a')
    useMemoryGraphStore.getState().setEgoHits(new Map([['a', 1]]))
    const v = useMemoryGraphStore.getState().payloadVersion
    useMemoryGraphStore.getState().setPayload(payloadOf([factNode('z')], []), null)
    const s = useMemoryGraphStore.getState()
    expect(s.payloadVersion).toBe(v + 1)
    expect(s.selectedNodeId).toBeNull()
    expect(s.egoHits).toBeNull()
  })

  it('setNodeLearning patches one node WITHOUT bumping payloadVersion (no re-layout)', () => {
    const store = useMemoryGraphStore.getState()
    store.setPayload(PAYLOAD, null)
    const v = useMemoryGraphStore.getState().payloadVersion
    useMemoryGraphStore.getState().setNodeLearning('a', {
      status: 'tentative',
      score: 0.5,
      uses: 1,
      usefulCount: 1,
      negativeCount: 0,
      lastUsedAt: 1,
      recentTrail: [],
    })
    const s = useMemoryGraphStore.getState()
    expect(s.payloadVersion).toBe(v)
    expect(s.payload!.nodes.find((n) => n.id === 'a')!.learning?.status).toBe('tentative')
    expect(s.payload!.nodes.find((n) => n.id === 'b')!.learning).toBeNull()
  })

  it('reset restores every default (payload, filters, selection, search)', () => {
    const store = useMemoryGraphStore.getState()
    store.setPayload(PAYLOAD, { id: 'ollama', dimensions: 768 })
    useMemoryGraphStore.getState().select('a')
    useMemoryGraphStore.getState().toggleCommunity(0)
    useMemoryGraphStore.getState().setSearchText('x')
    useMemoryGraphStore.getState().setLocked(true)
    useMemoryGraphStore.getState().reset()
    const s = useMemoryGraphStore.getState()
    expect(s.payload).toBeNull()
    expect(s.provider).toBeNull()
    expect(s.selectedNodeId).toBeNull()
    expect(s.hiddenCommunities.size).toBe(0)
    expect(s.searchText).toBe('')
    expect(s.locked).toBe(false)
  })
})

describe('computeNodeIntensity', () => {
  const base = {
    payload: PAYLOAD,
    searchText: '',
    egoHits: null,
    hoveredNodeId: null,
    highlightedNodeIds: null,
    selectedNodeId: null,
    timeFilter: 'all' as const,
  }

  it('defaults to full intensity', () => {
    expect(computeNodeIntensity(base, PAYLOAD.nodes[0]!, 0)).toBe(1)
  })

  it('live search: matches full, rest dim to 0.15', () => {
    const s = { ...base, searchText: 'Fact a' }
    expect(computeNodeIntensity(s, PAYLOAD.nodes[0]!, 0)).toBe(1)
    expect(computeNodeIntensity(s, PAYLOAD.nodes[2]!, 0)).toBe(0.15)
  })

  it('ego hits: score-weighted hits, half-intensity neighbors, deep-dim rest', () => {
    const s = { ...base, egoHits: new Map([['a', 0.8]]) }
    expect(computeNodeIntensity(s, PAYLOAD.nodes[0]!, 0)).toBe(1) // the (max-score) hit
    expect(computeNodeIntensity(s, PAYLOAD.nodes[1]!, 0)).toBe(0.5) // neighbor of a
    expect(computeNodeIntensity(s, PAYLOAD.nodes[2]!, 0)).toBe(0.12) // unrelated
  })

  it('time filter caps stale nodes at 0.3 without hiding fresh ones', () => {
    const now = 25 * 60 * 60 * 1000 // 25h — one hour past the 24h window for updatedAt 0
    const fresh = factNode('fresh', { updatedAt: now - 60 * 60 * 1000 })
    const stale = factNode('stale', { updatedAt: 0 })
    const s = { ...base, timeFilter: '24h' as const }
    expect(computeNodeIntensity(s, fresh, now)).toBe(1)
    expect(computeNodeIntensity(s, stale, now)).toBe(0.3)
  })
})
