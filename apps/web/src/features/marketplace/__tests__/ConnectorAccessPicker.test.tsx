// "Who can use it?" on a connected connector's page. Connecting gives a
// connector to nobody, and the only way to grant used to be drawing an edge on
// the Org chart, so a connector read as connected while no agent could call it.

import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { connectorBySlug } from '@clawboo/connector-catalog'

import { server } from '@/__vitest__/mswServer'
import type { AgentState } from '@/stores/fleet'
import { useFleetStore } from '@/stores/fleet'
import { useToastStore } from '@/stores/toast'

import { ConnectorAccessPicker } from '../ConnectorAccessPicker'

const LINEAR = connectorBySlug('linear')!
const CONNECTOR_ID = 'conn:connector:clawboo:mcp:linear'

const agent = (id: string, name: string, runtime: string) =>
  ({ id, name, runtime, teamId: 't' }) as AgentState

let grants: { subjectKind: string; subjectId: string; connectorId: string; revokedAt: null }[] = []
let posted: Record<string, unknown>[] = []

beforeEach(() => {
  grants = [
    { subjectKind: 'agent', subjectId: 'scout', connectorId: CONNECTOR_ID, revokedAt: null },
  ]
  posted = []
  useToastStore.setState({ toasts: [] })
  useFleetStore.setState({
    agents: [
      agent('scout', 'Scout', 'clawboo-native'),
      agent('writer', 'Writer', 'claude-code'),
      agent('claw', 'Claw', 'openclaw'),
    ],
  })
  server.use(
    http.get('/api/connectors', () =>
      HttpResponse.json({
        connectors: [
          { connectorId: CONNECTOR_ID, slug: 'linear', toolCount: 1, tools: [], skipped: [] },
        ],
      }),
    ),
    http.get('/api/grants', () => HttpResponse.json({ ok: true, grants })),
    http.post('/api/grants', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>
      posted.push(body)
      grants = [
        ...grants,
        {
          subjectKind: 'agent',
          subjectId: String(body['subjectId']),
          connectorId: CONNECTOR_ID,
          revokedAt: null,
        },
      ]
      return HttpResponse.json({ ok: true, grant: {} })
    }),
  )
})
afterEach(() => cleanup())

describe('ConnectorAccessPicker', () => {
  it('shows who already has access and which agents cannot take it', async () => {
    render(<ConnectorAccessPicker def={LINEAR} connected askFor={null} />)
    expect(await screen.findByRole('heading', { name: 'Who can use it?' })).toBeInTheDocument()
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Scout/ })).toBeChecked())
    expect(screen.getByRole('checkbox', { name: /Scout/ })).toBeDisabled()
    expect(screen.getByText('Has access')).toBeInTheDocument()
    expect(screen.getByRole('checkbox', { name: /Claw/ })).toBeDisabled()
    expect(screen.getByRole('checkbox', { name: /Writer/ })).not.toBeChecked()
  })

  it('gives the picked agents write access, with risky calls asking first', async () => {
    const user = userEvent.setup()
    render(<ConnectorAccessPicker def={LINEAR} connected askFor={null} />)
    await user.click(await screen.findByRole('checkbox', { name: /Writer/ }))
    await user.click(screen.getByRole('button', { name: 'Give access' }))

    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({
      subjectKind: 'agent',
      subjectId: 'writer',
      capabilityKind: 'connector',
      connectorId: CONNECTOR_ID,
      mode: 'write',
      approvalPolicy: 'risk',
    })
    await waitFor(() => expect(screen.getByRole('checkbox', { name: /Writer/ })).toBeDisabled())
  })

  it('gives the agent that asked for it access once it is connected, and only once', async () => {
    const { rerender } = render(
      <ConnectorAccessPicker
        def={LINEAR}
        connected
        askFor={{ agentId: 'writer', agentName: 'Writer' }}
      />,
    )
    await waitFor(() => expect(posted).toHaveLength(1))
    expect(posted[0]).toMatchObject({ subjectId: 'writer', mode: 'write', approvalPolicy: 'risk' })

    rerender(
      <ConnectorAccessPicker
        def={LINEAR}
        connected
        askFor={{ agentId: 'writer', agentName: 'Writer' }}
      />,
    )
    await new Promise((r) => setTimeout(r, 50))
    expect(posted).toHaveLength(1)
  })

  it('does not grant an asking agent that already has access, and shows nothing while disconnected', async () => {
    const { rerender } = render(
      <ConnectorAccessPicker
        def={LINEAR}
        connected={false}
        askFor={{ agentId: 'scout', agentName: 'Scout' }}
      />,
    )
    expect(screen.queryByTestId('connector-access-picker')).toBeNull()
    rerender(
      <ConnectorAccessPicker
        def={LINEAR}
        connected
        askFor={{ agentId: 'scout', agentName: 'Scout' }}
      />,
    )
    await screen.findByTestId('connector-access-picker')
    await new Promise((r) => setTimeout(r, 50))
    expect(posted).toEqual([])
  })
})
