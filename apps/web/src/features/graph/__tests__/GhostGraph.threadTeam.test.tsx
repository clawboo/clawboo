// A thread pulled off Boo Zero and let go on the Org chart's empty canvas.
//
// Boo Zero belongs to no team, and the Org chart draws teams (plus Boo Zero),
// so an agent made from that thread must join a team or it lands nowhere on
// screen. It joins the team the + button's agent would: the one selected in the
// sidebar, or the first team when none is. The picker names that team, and with
// no Gateway connected the agent is a Clawboo Native one, read back into the
// fleet the canvas draws from (no Gateway event will put it there).
//
// Only `<ReactFlow>` is stubbed, to capture `onConnectEnd` (see
// GhostGraph.deleteKey.test.tsx for why); the thread hook, the picker and the
// create all run for real.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { ReactFlowProvider } from '@xyflow/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '@/__vitest__/mswServer'
import { useConnectionStore } from '@/stores/connection'
import { useFleetStore } from '@/stores/fleet'
import type { Team } from '@/stores/team'
import { useTeamStore } from '@/stores/team'

const reactFlowProps = vi.hoisted(() => ({ current: null as Record<string, unknown> | null }))

vi.mock('@xyflow/react', async (importActual) => ({
  ...(await importActual<typeof import('@xyflow/react')>()),
  ReactFlow: (props: Record<string, unknown>) => {
    reactFlowProps.current = props
    return <div data-testid="react-flow-stub" />
  },
}))

const { GhostGraph } = await import('../GhostGraph')

function team(id: string, name: string): Team {
  return {
    id,
    name,
    icon: '📈',
    color: '#10b981',
    colorCollectionId: null,
    templateId: null,
    agentCount: 2,
    leaderAgentId: null,
    isArchived: false,
    serverOrchestrated: true,
  }
}

let created: Record<string, unknown> | null = null

beforeEach(() => {
  created = null
  reactFlowProps.current = null
  useFleetStore.setState({ agents: [], selectedAgentId: null })
  useConnectionStore.setState({ status: 'connected', client: null, gatewayUrl: '' })
  useTeamStore.setState({
    teams: [team('t1', 'Growth Studio'), team('t2', 'Ops Crew')],
    selectedTeamId: null,
  })
  server.use(
    http.get('/api/graph-layout', () => HttpResponse.json({ positions: {} })),
    http.get('/api/obs/graph', () => HttpResponse.json({ nodes: [], edges: [] })),
    http.get('/api/obs/health', () => HttpResponse.json({ agents: [] })),
    http.get('/api/obs/events', () => HttpResponse.json({ events: [] })),
    http.get('/api/connectors', () => HttpResponse.json({ connectors: [] })),
    http.get('/api/connectors/configured', () => HttpResponse.json({ slugs: [], supplied: [] })),
    http.get('/api/connectors/composio', () => HttpResponse.json({ connected: [] })),
    http.post('/api/agents', async ({ request }) => {
      created = (await request.json()) as Record<string, unknown>
      return HttpResponse.json({ agent: { id: 'a-new' } }, { status: 201 })
    }),
    // The registry, once the agent exists in it.
    http.get('/api/agents', () =>
      HttpResponse.json({
        defaultId: '',
        mainKey: 'main',
        stale: false,
        agents: created
          ? [
              {
                id: 'a-new',
                displayName: created['name'],
                teamId: created['teamId'],
                runtime: created['sourceId'],
                sessionKey: null,
              },
            ]
          : [],
      }),
    ),
    // What the canvas reads for an agent it now draws.
    http.get('/api/capabilities', () => HttpResponse.json({ records: [], sources: [] })),
    // The thread's routing line, written on Boo Zero after the create.
    http.get('/api/agents/bz/files/AGENTS.md', () =>
      HttpResponse.json({ name: 'AGENTS.md', content: '# AGENTS\n' }),
    ),
    http.put('/api/agents/bz/files/AGENTS.md', async ({ request }) =>
      HttpResponse.json({ name: 'AGENTS.md', ...((await request.json()) as object) }),
    ),
  )
})

afterEach(() => {
  cleanup()
  useConnectionStore.setState({ status: 'disconnected', client: null, gatewayUrl: '' })
})

/** Let a thread off Boo Zero go on empty canvas, as React Flow reports it. */
function dropThreadOffBooZero(): void {
  const onConnectEnd = reactFlowProps.current?.['onConnectEnd'] as (
    event: MouseEvent,
    state: { isValid: boolean | null; fromNode: unknown; toNode: unknown },
  ) => void
  act(() =>
    onConnectEnd(new MouseEvent('mouseup', { clientX: 300, clientY: 200 }), {
      isValid: null,
      fromNode: {
        id: 'boo-bz',
        type: 'boo',
        position: { x: 0, y: 0 },
        data: { agentId: 'bz', name: 'Boo Zero', teamId: null },
      },
      toNode: null,
    }),
  )
}

async function createFromPicker(name: string): Promise<void> {
  const user = userEvent.setup()
  const picker = screen.getByRole('dialog', { name: 'Connect to' })
  await user.click(within(picker).getByRole('option', { name: /^New agent/ }))
  await user.type(within(picker).getByRole('combobox'), `${name}{Enter}`)
  await waitFor(() => expect(created).not.toBeNull())
}

function renderOrgChart() {
  return render(
    <ReactFlowProvider>
      <GhostGraph scope="atlas" />
    </ReactFlowProvider>,
  )
}

describe('A thread off Boo Zero on the Org chart', () => {
  it('makes an agent in the first team when the sidebar has none selected', async () => {
    renderOrgChart()
    dropThreadOffBooZero()

    const picker = screen.getByRole('dialog', { name: 'Connect to' })
    expect(within(picker).getByText('Name one; it joins Growth Studio')).toBeInTheDocument()

    await createFromPicker('Bea')
    // No Gateway is connected, so the agent runs on Clawboo Native.
    expect(created).toMatchObject({ name: 'Bea', teamId: 't1', sourceId: 'clawboo-native' })
    // And it is in the fleet the canvas draws, in its team.
    await waitFor(() =>
      expect(useFleetStore.getState().agents).toContainEqual(
        expect.objectContaining({ id: 'a-new', name: 'Bea', teamId: 't1' }),
      ),
    )
  })

  it('makes an agent in the team selected in the sidebar', async () => {
    useTeamStore.setState({ selectedTeamId: 't2' })
    renderOrgChart()
    dropThreadOffBooZero()

    const picker = screen.getByRole('dialog', { name: 'Connect to' })
    expect(within(picker).getByText('Name one; it joins Ops Crew')).toBeInTheDocument()

    await createFromPicker('Bea')
    expect(created).toMatchObject({ name: 'Bea', teamId: 't2' })
  })
})
