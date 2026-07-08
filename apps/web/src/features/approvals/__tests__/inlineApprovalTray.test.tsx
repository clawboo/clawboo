// InlineApprovalTray — renders pending approvals (exec + tool/delegation) inline,
// scoped to the current chat's agent/team. RTL + msw (onUnhandledRequest:'error').

import { cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { useApprovalsStore } from '@/stores/approvals'
import { useBooZeroStore } from '@/stores/booZero'
import { useFleetStore } from '@/stores/fleet'
import { InlineApprovalTray } from '../InlineApprovalTray'

const toolApproval = {
  id: 'tc-1',
  toolName: 'delete_path',
  agentId: 'a1',
  argsSummary: null,
  reason: 'destructive tool',
  createdAt: 1000,
  expiresAt: Date.now() + 60_000,
}

const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms))

beforeEach(() => {
  useApprovalsStore.setState({ pendingApprovals: new Map() })
  useBooZeroStore.setState({ booZeroAgentId: null })
  // A team member (a1) + the teamless universal Boo Zero leader (bz).
  useFleetStore.setState({
    agents: [
      { id: 'a1', name: 'Coder', teamId: 't1' },
      { id: 'bz', name: 'Boo Zero', teamId: null },
    ] as never,
  })
})
afterEach(() => cleanup())

describe('InlineApprovalTray', () => {
  it('renders nothing when there are no pending approvals', async () => {
    server.use(http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [] })))
    const { container } = render(<InlineApprovalTray teamId="t1" />)
    await tick()
    expect(container).toBeEmptyDOMElement()
  })

  it('shows a scoped team tool/delegation approval inline', async () => {
    server.use(
      http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [toolApproval] })),
    )
    render(<InlineApprovalTray teamId="t1" />)
    // Generous budget: the tray polls /api/tools/approvals on mount; under full-suite
    // parallel load the fetch + re-render can exceed RTL's 1s default.
    expect(await screen.findByText('delete_path', {}, { timeout: 4000 })).toBeInTheDocument()
  })

  it('excludes an approval for an agent that is NOT in the scoped team', async () => {
    server.use(
      http.get('/api/tools/approvals', () =>
        HttpResponse.json({ approvals: [{ ...toolApproval, agentId: 'stranger' }] }),
      ),
    )
    render(<InlineApprovalTray teamId="t1" />)
    await tick(40)
    expect(screen.queryByText('delete_path')).not.toBeInTheDocument()
  })

  it('shows the teamless Boo Zero leader’s delegation approval in a team-scoped tray', async () => {
    // The risky-delegation gate is raised BY the universal Boo Zero leader (teamless,
    // so NOT in the team's agent set). It must still surface in the team chat.
    useBooZeroStore.setState({ booZeroAgentId: 'bz' })
    server.use(
      http.get('/api/tools/approvals', () =>
        HttpResponse.json({ approvals: [{ ...toolApproval, toolName: 'delegate', agentId: 'bz' }] }),
      ),
    )
    render(<InlineApprovalTray teamId="t1" />)
    expect(await screen.findByText('delegate', {}, { timeout: 4000 })).toBeInTheDocument()
  })
})
