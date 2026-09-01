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
  argsSummary: '{"path":"/tmp/report.pdf"}',
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
    expect(
      await screen.findByText(/wants to delete a file/i, {}, { timeout: 4000 }),
    ).toBeInTheDocument()
  })

  it('shows an approval that names NO agent in a 1:1 chat', async () => {
    // THE BUG THIS PINS. An OpenClaw session reaches the tools server over one
    // process-wide URL that cannot carry an agent, so its approvals arrive with
    // `agentId: null`. Excluded, the gate appeared nowhere the operator was
    // looking, the call sat until it timed out, and the agent reported the stall
    // to the operator as "the service is unavailable".
    server.use(
      http.get('/api/tools/approvals', () =>
        HttpResponse.json({ approvals: [{ ...toolApproval, agentId: null }] }),
      ),
    )
    render(<InlineApprovalTray agentId="a1" />)
    expect(
      await screen.findByText(/wants to delete a file/i, {}, { timeout: 4000 }),
    ).toBeInTheDocument()
  })

  it('shows an approval that names no agent in a TEAM chat too', async () => {
    server.use(
      http.get('/api/tools/approvals', () =>
        HttpResponse.json({ approvals: [{ ...toolApproval, agentId: null }] }),
      ),
    )
    render(<InlineApprovalTray teamId="t1" />)
    expect(
      await screen.findByText(/wants to delete a file/i, {}, { timeout: 4000 }),
    ).toBeInTheDocument()
  })

  it('still excludes an approval belonging to a DIFFERENT agent', async () => {
    // Widening to the unattributable ones must not widen to everyone else's.
    server.use(
      http.get('/api/tools/approvals', () =>
        HttpResponse.json({ approvals: [{ ...toolApproval, agentId: 'stranger' }] }),
      ),
    )
    render(<InlineApprovalTray agentId="a1" />)
    await tick(40)
    expect(screen.queryByText(/wants to delete a file/i)).not.toBeInTheDocument()
  })

  it('excludes an approval for an agent that is NOT in the scoped team', async () => {
    server.use(
      http.get('/api/tools/approvals', () =>
        HttpResponse.json({ approvals: [{ ...toolApproval, agentId: 'stranger' }] }),
      ),
    )
    render(<InlineApprovalTray teamId="t1" />)
    await tick(40)
    expect(screen.queryByText(/wants to delete a file/i)).not.toBeInTheDocument()
  })

  it('shows the teamless Boo Zero leader’s delegation approval in a team-scoped tray', async () => {
    // The risky-delegation gate is raised BY the universal Boo Zero leader (teamless,
    // so NOT in the team's agent set). It must still surface in the team chat.
    useBooZeroStore.setState({ booZeroAgentId: 'bz' })
    server.use(
      http.get('/api/tools/approvals', () =>
        HttpResponse.json({
          approvals: [{ ...toolApproval, toolName: 'delegate', agentId: 'bz' }],
        }),
      ),
    )
    render(<InlineApprovalTray teamId="t1" />)
    expect(
      await screen.findByText(/wants to run "Delegate"/i, {}, { timeout: 4000 }),
    ).toBeInTheDocument()
  })
})
