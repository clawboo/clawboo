// Legend: per-community hide toggles + the tri-state select-all.

import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MemoryGraphNode, MemoryGraphPayload } from '@/lib/memoryClient'
import { LegendPanel } from '../graph/LegendPanel'
import { useMemoryGraphStore } from '../graph/store'

function factNode(id: string, community: number): MemoryGraphNode {
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
    community,
    hasEmbedding: false,
    learning: null,
  }
}

const PAYLOAD: MemoryGraphPayload = {
  nodes: [factNode('a', 0), factNode('b', 0), factNode('c', 1)],
  edges: [],
  communities: [
    { id: 0, label: 'deploy', size: 2 },
    { id: 1, label: 'auth', size: 1 },
  ],
  totalFacts: 3,
  totalProcedures: 0,
  truncated: false,
  similarityAvailable: false,
}

beforeEach(() => {
  useMemoryGraphStore.getState().reset()
  useMemoryGraphStore.getState().setPayload(PAYLOAD, null)
})
afterEach(() => cleanup())

describe('LegendPanel', () => {
  it('renders a checked row per community + the counts footer', () => {
    render(<LegendPanel />)
    expect(screen.getByTestId('memory-graph-legend')).toBeInTheDocument()
    expect(screen.getByText('deploy')).toBeInTheDocument()
    expect(screen.getByText('auth')).toBeInTheDocument()
    expect(screen.getByTestId('legend-community-0')).toBeChecked()
    expect(screen.getByText('3 facts · 0 procedures · 2 clusters')).toBeInTheDocument()
  })

  it('unticking a community hides it in the store; re-ticking shows it', async () => {
    const user = userEvent.setup()
    render(<LegendPanel />)
    await user.click(screen.getByTestId('legend-community-1'))
    expect(useMemoryGraphStore.getState().hiddenCommunities.has(1)).toBe(true)
    await user.click(screen.getByTestId('legend-community-1'))
    expect(useMemoryGraphStore.getState().hiddenCommunities.has(1)).toBe(false)
  })

  it('select-all is tri-state: none hidden → hide all → show all; partial = indeterminate', async () => {
    const user = userEvent.setup()
    render(<LegendPanel />)
    const selectAll = screen.getByTestId('legend-select-all') as HTMLInputElement

    expect(selectAll.checked).toBe(true)
    expect(selectAll.indeterminate).toBe(false)

    await user.click(selectAll) // none hidden → hide all
    expect(useMemoryGraphStore.getState().hiddenCommunities.size).toBe(2)

    await user.click(selectAll) // all hidden → show all
    expect(useMemoryGraphStore.getState().hiddenCommunities.size).toBe(0)

    await user.click(screen.getByTestId('legend-community-0')) // partial
    expect(selectAll.indeterminate).toBe(true)
  })
})
