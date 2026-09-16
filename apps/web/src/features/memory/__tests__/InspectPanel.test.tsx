// Graph inspector: fact fields render, neighbor chips move the selection, and
// the feedback loop (Helpful → POST → learning patched into the store).

import { ReactFlowProvider } from '@xyflow/react'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { MemoryGraphNode, MemoryGraphPayload } from '@/lib/memoryClient'
import { server } from '../../../__vitest__/mswServer'
import { InspectPanel } from '../graph/InspectPanel'
import { useMemoryGraphStore } from '../graph/store'

function factNode(id: string, overrides: Partial<MemoryGraphNode> = {}): MemoryGraphNode {
  return {
    id,
    kind: 'fact',
    title: `Fact ${id}`,
    content: `Body of ${id}`,
    contentTruncated: false,
    tags: ['deploy'],
    scope: 'team',
    scopeTeamId: 't1',
    scopeAgentId: null,
    createdByAgentId: null,
    createdByRuntime: null,
    sourceTaskId: null,
    createdAt: 0,
    updatedAt: 0,
    degree: 1,
    community: 0,
    hasEmbedding: false,
    learning: null,
    ...overrides,
  }
}

const PAYLOAD: MemoryGraphPayload = {
  nodes: [factNode('f1'), factNode('f2')],
  edges: [
    {
      id: 'tag:f1:f2',
      source: 'f1',
      target: 'f2',
      kind: 'tag',
      weight: 0.62,
      sharedTags: ['deploy'],
    },
  ],
  communities: [{ id: 0, label: 'deploy', size: 2 }],
  totalFacts: 2,
  totalProcedures: 0,
  truncated: false,
  similarityAvailable: false,
}

function renderPanel() {
  return render(
    <ReactFlowProvider>
      <InspectPanel />
    </ReactFlowProvider>,
  )
}

beforeEach(() => {
  useMemoryGraphStore.getState().reset()
  useMemoryGraphStore.getState().setPayload(PAYLOAD, null)
})
afterEach(() => cleanup())

describe('InspectPanel', () => {
  it('renders nothing while no node is selected', () => {
    renderPanel()
    expect(screen.queryByTestId('memory-inspect-panel')).not.toBeInTheDocument()
  })

  it('renders the selected fact: pills, title, content, tags, neighbors', () => {
    useMemoryGraphStore.getState().select('f1')
    renderPanel()
    expect(screen.getByTestId('memory-inspect-panel')).toBeInTheDocument()
    expect(screen.getByText('Fact f1')).toBeInTheDocument()
    expect(screen.getByText('Body of f1')).toBeInTheDocument()
    expect(screen.getByText('fact')).toBeInTheDocument()
    expect(screen.getByText('team')).toBeInTheDocument()
    expect(screen.getByTestId('mem-neighbor-f2')).toBeInTheDocument()
  })

  it('neighbor chip click moves the selection', async () => {
    useMemoryGraphStore.getState().select('f1')
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByTestId('mem-neighbor-f2'))
    expect(useMemoryGraphStore.getState().selectedNodeId).toBe('f2')
  })

  it('Helpful posts feedback and patches the learning entry into the store', async () => {
    let postedBody: unknown = null
    server.use(
      http.post('/api/memory/feedback', async ({ request }) => {
        postedBody = await request.json()
        return HttpResponse.json({
          ok: true,
          learning: {
            status: 'tentative',
            score: 1,
            uses: 1,
            usefulCount: 1,
            negativeCount: 0,
            lastUsedAt: 1,
            recentTrail: [],
          },
        })
      }),
    )
    useMemoryGraphStore.getState().select('f1')
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByTestId('memory-feedback-useful'))
    await waitFor(() =>
      expect(
        useMemoryGraphStore.getState().payload!.nodes.find((n) => n.id === 'f1')!.learning?.status,
      ).toBe('tentative'),
    )
    expect(postedBody).toMatchObject({ factId: 'f1', outcome: 'useful' })
    // The pill re-renders from the patched store entry.
    expect(await screen.findByText('tentative')).toBeInTheDocument()
  })

  it('tag chip click pivots the graph search to that tag', async () => {
    useMemoryGraphStore.getState().select('f1')
    const user = userEvent.setup()
    renderPanel()
    await user.click(screen.getByRole('button', { name: 'deploy' }))
    expect(useMemoryGraphStore.getState().searchText).toBe('deploy')
  })
})
