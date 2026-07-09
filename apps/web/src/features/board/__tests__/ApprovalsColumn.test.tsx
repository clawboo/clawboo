// The Board's "Needs approval" column: collapses to a rail when empty, expands with
// cards when a tool/delegation approval is pending, and resolves via the tool-approval
// endpoint. RTL + msw (onUnhandledRequest:'error').

import { cleanup, render, screen, waitFor } from '@testing-library/react'

// Generous async budget: the tray/column poll `/api/tools/approvals` on mount, and
// under full-suite parallel load the fetch + re-render can exceed RTL's 1s default.
const T = { timeout: 4000 }
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { useApprovalsStore } from '@/stores/approvals'
import { useFleetStore } from '@/stores/fleet'
import { ApprovalsColumn } from '../ApprovalsColumn'

const toolApproval = {
  id: 'tc-1',
  toolName: 'delete_path',
  agentId: 'a1',
  argsSummary: '{"path":"/tmp/x"}',
  reason: 'destructive tool',
  createdAt: 1000,
  expiresAt: Date.now() + 60_000,
}

beforeEach(() => {
  useApprovalsStore.setState({ pendingApprovals: new Map() })
  useFleetStore.setState({ agents: [{ id: 'a1', name: 'Coder', teamId: 't1' }] as never })
})
afterEach(() => cleanup())

describe('ApprovalsColumn', () => {
  it('collapses to a rail when there are no pending approvals', async () => {
    server.use(http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [] })))
    render(<ApprovalsColumn teamFilter="all" />)
    expect(await screen.findByTestId('board-approvals-rail', {}, T)).toBeInTheDocument()
    expect(screen.queryByTestId('board-column-approvals')).not.toBeInTheDocument()
    // The empty rail is non-interactive (nothing to expand to).
    expect(screen.getByTestId('board-approvals-rail')).toBeDisabled()
  })

  it('auto-expands with a card when a tool/delegation approval is pending', async () => {
    server.use(
      http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [toolApproval] })),
    )
    render(<ApprovalsColumn teamFilter="all" />)
    expect(await screen.findByTestId('board-column-approvals', {}, T)).toBeInTheDocument()
    expect(screen.getByText('delete_path')).toBeInTheDocument()
    expect(screen.queryByTestId('board-approvals-rail')).not.toBeInTheDocument()
  })

  it('resolving a tool approval POSTs the decision to the tool-approval endpoint', async () => {
    let resolved: { id?: string; decision?: string } = {}
    server.use(
      http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [toolApproval] })),
      http.post('/api/tools/approvals/:id/resolve', async ({ params, request }) => {
        const body = (await request.json()) as { decision: string }
        resolved = { id: params['id'] as string, decision: body.decision }
        return HttpResponse.json({ ok: true })
      }),
    )
    render(<ApprovalsColumn teamFilter="all" />)
    await screen.findByText('delete_path', {}, T)
    await userEvent.click(screen.getByRole('button', { name: /allow once/i }))
    await waitFor(() => expect(resolved.id).toBe('tc-1'), T)
    expect(resolved.decision).toBe('allow_once')
  })
})
