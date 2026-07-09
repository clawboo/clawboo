// Regression test for the team chat header's boo/skill count. The graph store is
// shared across Atlas + every team graph, so the header must NOT show a stale
// count from the previous scope (e.g. "23 Boos" from Atlas) before the current
// team's graph hydrates — it gates on `graphScopeKey === team:<id>`.

import { cleanup, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { GraphNode } from '@/features/graph/types'
import { useGraphStore } from '@/features/graph/store'
import type { Team } from '@/stores/team'

import { GroupChatViewHeader } from '../GroupChatViewHeader'

const team: Team = {
  id: 't1',
  name: 'Test Team',
  icon: '🚀',
  color: '#3b82f6',
  colorCollectionId: null,
  templateId: null,
  agentCount: 5,
  leaderAgentId: null,
  isArchived: false,
  serverOrchestrated: false,
}

function booNodes(n: number): GraphNode[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `boo-${i}`,
    type: 'boo',
    position: { x: 0, y: 0 },
    data: {},
  })) as unknown as GraphNode[]
}

beforeEach(() => {
  useGraphStore.setState({ nodes: [], edges: [], graphScopeKey: null })
})
afterEach(() => cleanup())

describe('GroupChatViewHeader — boo/skill count', () => {
  it('shows the "…" placeholder when a stale count from another scope is still in the store', () => {
    // Simulate Atlas's nodes lingering in the shared store before the team rebuild.
    useGraphStore.setState({ nodes: booNodes(23), graphScopeKey: 'atlas' })
    render(<GroupChatViewHeader team={team} />)

    expect(screen.getByText('…')).toBeInTheDocument()
    expect(screen.queryByText(/\bBoos?\b/)).toBeNull() // never flashes "23 Boos"
  })

  it('shows the count once the graph has rebuilt for THIS team', () => {
    useGraphStore.setState({ nodes: booNodes(5), graphScopeKey: 'team:t1' })
    render(<GroupChatViewHeader team={team} />)

    expect(screen.getByText('5 Boos')).toBeInTheDocument()
    expect(screen.queryByText('…')).toBeNull()
  })
})
