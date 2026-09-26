// The graph's Enter-search applies only the answer to the search still wanted:
// an older request resolving late, or one answered against a payload a refresh
// has since replaced, must not light up the wrong nodes.

import { act, cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { MemoryGraphNode, MemoryGraphPayload, MemorySearchResult } from '@/lib/memoryClient'
import { useMemoryGraphStore } from '../graph/store'

const pending: { query: string; resolve: (r: MemorySearchResult[]) => void }[] = []

vi.mock('@/lib/memoryClient', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/memoryClient')>()),
  searchMemory: vi.fn(
    (query: string) =>
      new Promise<MemorySearchResult[]>((resolve) => pending.push({ query, resolve })),
  ),
}))
vi.mock('../graph/MemoryGraphCanvas', () => ({ MemoryGraphCanvas: () => null }))
vi.mock('../graph/LegendPanel', () => ({ LegendPanel: () => null }))
vi.mock('../graph/InspectPanel', () => ({ InspectPanel: () => null }))
vi.mock('../graph/useNewLinksRefresh', () => ({
  useNewLinksRefresh: () => ({ linksReady: false, refreshNow: () => undefined }),
}))

const { MemoryGraphView } = await import('../graph/MemoryGraphView')

function node(id: string): MemoryGraphNode {
  return {
    id,
    kind: 'fact',
    title: `Fact ${id}`,
    content: '',
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
    hasEmbedding: true,
    learning: null,
  }
}

const payload = (ids: string[]): MemoryGraphPayload => ({
  nodes: ids.map(node),
  edges: [],
  communities: [],
  totalFacts: ids.length,
  totalProcedures: 0,
  truncated: false,
  similarityAvailable: true,
})

const hit = (id: string, score = 1): MemorySearchResult =>
  ({ id, score }) as unknown as MemorySearchResult

beforeEach(() => {
  pending.length = 0
  useMemoryGraphStore.getState().reset()
  useMemoryGraphStore.getState().setPayload(payload(['f1', 'f2']), null)
})
afterEach(() => cleanup())

async function search(user: ReturnType<typeof userEvent.setup>, text: string): Promise<void> {
  const input = screen.getByTestId('memory-graph-search')
  await user.clear(input)
  await user.type(input, `${text}{Enter}`)
}

describe('MemoryGraphView Enter-search', () => {
  it('ignores an older search that resolves after a newer one', async () => {
    const user = userEvent.setup()
    render(<MemoryGraphView />)

    await search(user, 'alpha')
    await search(user, 'beta')
    expect(pending.map((p) => p.query)).toEqual(['alpha', 'beta'])

    await act(async () => pending[1]!.resolve([hit('f2')]))
    await act(async () => pending[0]!.resolve([hit('f1')]))

    const state = useMemoryGraphStore.getState()
    expect([...(state.egoHits?.keys() ?? [])]).toEqual(['f2'])
    expect(state.selectedNodeId).toBe('f2')
  })

  it('matches hits against the payload present when the answer lands', async () => {
    const user = userEvent.setup()
    render(<MemoryGraphView />)

    await search(user, 'alpha')
    // A refresh replaces the graph while the search is in flight; f1 is gone.
    act(() => useMemoryGraphStore.getState().setPayload(payload(['f2']), null))
    await act(async () => pending[0]!.resolve([hit('f1')]))

    const state = useMemoryGraphStore.getState()
    expect(state.egoHits).toBeNull()
    expect(state.selectedNodeId).toBeNull()
  })
})
