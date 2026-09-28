// The canvas command bar, in both scopes.
//
// There is no edge-drawing mode to arm: every Boo's port is always live, so the
// old Connect toggle was a second way to do the same thing and is gone from
// both scopes. Both scopes lead with the + button, which puts a connector, skill
// or agent on the canvas attached to nothing. Both carry the activity feed,
// each scoped to what the canvas draws: every team in Atlas, one team in its own
// graph.
//
// Only `<ReactFlow>` is stubbed (see GhostGraph.deleteKey.test.tsx for why);
// the toolbar and the docks render for real.

import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { ReactFlowProvider } from '@xyflow/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { useTeamStore } from '@/stores/team'

vi.mock('@xyflow/react', async (importActual) => ({
  ...(await importActual<typeof import('@xyflow/react')>()),
  ReactFlow: () => <div data-testid="react-flow-stub" />,
}))

const { GhostGraph } = await import('../GhostGraph')

const obsQueries: string[] = []

beforeEach(() => {
  obsQueries.length = 0
  server.use(
    // The canvas's own positions and its loose nodes are read through this.
    http.get('/api/graph-layout', () => HttpResponse.json({ positions: {} })),
    http.get('/api/obs/graph', () => HttpResponse.json({ nodes: [], edges: [] })),
    http.get('/api/obs/health', () => HttpResponse.json({ agents: [] })),
    // What the thread picker prices its rows from, read on mount.
    http.get('/api/connectors', () => HttpResponse.json({ connectors: [] })),
    http.get('/api/connectors/configured', () => HttpResponse.json({ slugs: [], supplied: [] })),
    http.get('/api/connectors/composio', () => HttpResponse.json({ connected: [] })),
    http.get('/api/obs/events', ({ request }) => {
      obsQueries.push(new URL(request.url).search)
      return HttpResponse.json({ events: [] })
    }),
  )
  useTeamStore.setState({
    selectedTeamId: 't1',
    teams: [
      {
        id: 't1',
        name: 'Growth Studio',
        icon: '📈',
        color: '#10b981',
        colorCollectionId: null,
        templateId: null,
        agentCount: 4,
        leaderAgentId: null,
        isArchived: false,
        serverOrchestrated: true,
      },
    ],
  })
})

afterEach(() => cleanup())

function renderGraph(scope: 'atlas' | 'team') {
  return render(
    <ReactFlowProvider>
      <GhostGraph scope={scope} />
    </ReactFlowProvider>,
  )
}

describe('GhostGraph command bar', () => {
  it.each(['atlas', 'team'] as const)('has no Connect toggle in the %s scope', (scope) => {
    renderGraph(scope)
    expect(screen.queryByRole('button', { name: /connect agents|drawing edges/i })).toBeNull()
  })

  it("opens every team's trail from Atlas", async () => {
    renderGraph('atlas')
    fireEvent.click(screen.getByRole('button', { name: 'Activity feed (all teams)' }))

    expect(screen.getByRole('complementary', { name: 'Activity, all teams' })).toHaveAttribute(
      'aria-hidden',
      'false',
    )
    await waitFor(() => expect(obsQueries.length).toBeGreaterThan(0))
    expect(obsQueries.every((q) => !q.includes('teamId='))).toBe(true)
  })

  it("opens this team's trail from a team graph", async () => {
    renderGraph('team')
    fireEvent.click(screen.getByRole('button', { name: 'Activity feed (this team)' }))

    expect(screen.getByRole('complementary', { name: 'Activity, Growth Studio' })).toHaveAttribute(
      'aria-hidden',
      'false',
    )
    await waitFor(() => expect(obsQueries.some((q) => q.includes('teamId=t1'))).toBe(true))
  })

  it('keeps the two right-edge docks from stacking', () => {
    const { container } = renderGraph('team')
    fireEvent.click(screen.getByRole('button', { name: 'Activity feed (this team)' }))
    fireEvent.click(screen.getByRole('button', { name: 'Agent browser' }))

    // By attribute: a closed dock is aria-hidden, which is the point, and a
    // hidden element has no accessible name for a role query to match.
    expect(container.querySelector('[aria-label="Activity, Growth Studio"]')).toHaveAttribute(
      'aria-hidden',
      'true',
    )
  })

  it.each(['atlas', 'team'] as const)(
    'opens the add picker from the + button in the %s scope',
    (scope) => {
      renderGraph(scope)
      const plus = screen.getByRole('button', { name: 'Add a connector, skill or agent' })
      fireEvent.click(plus)
      expect(screen.getByRole('dialog', { name: 'Add to the graph' })).toBeInTheDocument()
      expect(plus).toHaveAttribute('aria-pressed', 'true')
    },
  )

  it("says which team a new agent joins, from the team's own graph", () => {
    renderGraph('team')
    fireEvent.click(screen.getByRole('button', { name: 'Add a connector, skill or agent' }))
    expect(screen.getByText('Name one; it joins Growth Studio')).toBeInTheDocument()
  })
})
