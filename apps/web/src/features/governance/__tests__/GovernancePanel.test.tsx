// Governance dashboard: budgets + audit render on mount (incl. the read-only
// tenantId — the dormant per-tenant seam) + the resume-a-paused-budget POST. The
// embedded <ToolApprovalQueue/> now always polls /api/tools/approvals, so every
// test stubs that endpoint (msw onUnhandledRequest:'error' would fail otherwise).

import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { GovernancePanel } from '../GovernancePanel'

function budget(over: Record<string, unknown> = {}) {
  return {
    id: 'b1',
    scope: 'team',
    scopeId: 'team-1',
    limitUsdCents: 100,
    spentUsdCents: 50,
    status: 'active',
    tenantId: 'acme',
    createdAt: 0,
    updatedAt: 0,
    ...over,
  }
}

beforeEach(() => {
  // The embedded approval queue polls this on mount.
  server.use(http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [] })))
})
afterEach(() => cleanup())

describe('GovernancePanel', () => {
  it('renders budgets + audit (incl. read-only tenantId) on mount', async () => {
    server.use(
      http.get('/api/governance/budgets', () => HttpResponse.json({ budgets: [budget()] })),
      http.get('/api/governance/audit', () =>
        HttpResponse.json({
          audit: [
            {
              id: 'a1',
              eventType: 'budget',
              agentId: null,
              taskId: null,
              teamId: null,
              tenantId: 'acme',
              summary: '{"x":1}',
              createdAt: 0,
            },
          ],
        }),
      ),
    )
    render(<GovernancePanel />)

    expect(await screen.findByTestId('governance-panel')).toBeInTheDocument()
    expect(await screen.findByTestId('budget-row')).toBeInTheDocument()
    expect(screen.getByTestId('budget-status')).toHaveTextContent('active')
    expect(screen.getByText(/tenant acme/)).toBeInTheDocument() // dormant per-tenant seam, read-only
    expect(await screen.findByTestId('audit-row')).toBeInTheDocument()
    // A healthy under-limit budget shows no "will re-pause" badge.
    expect(screen.queryByTestId('budget-will-repause')).toBeNull()
  })

  it('shows a "will re-pause" badge for a cap budget resumed while over its limit', async () => {
    server.use(
      http.get('/api/governance/budgets', () =>
        HttpResponse.json({
          budgets: [
            budget({ status: 'active', mode: 'cap', spentUsdCents: 120, limitUsdCents: 100 }),
          ],
        }),
      ),
      http.get('/api/governance/audit', () => HttpResponse.json({ audit: [] })),
    )
    render(<GovernancePanel />)

    expect(await screen.findByTestId('budget-will-repause')).toBeInTheDocument()
  })

  it('shows an error + retry when the budgets load fails (not a silent empty list)', async () => {
    server.use(
      http.get('/api/governance/budgets', () => new HttpResponse(null, { status: 500 })),
      http.get('/api/governance/audit', () => HttpResponse.json({ audit: [] })),
    )
    render(<GovernancePanel />)
    const err = await screen.findByTestId('governance-fetch-error')
    expect(within(err).getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })

  it('resumes a paused budget via POST …/resume', async () => {
    const resumeHit = vi.fn()
    server.use(
      http.get('/api/governance/budgets', () =>
        HttpResponse.json({ budgets: [budget({ status: 'paused' })] }),
      ),
      http.get('/api/governance/audit', () => HttpResponse.json({ audit: [] })),
      http.post('/api/governance/budgets/:scope/:scopeId/resume', ({ params }) => {
        resumeHit(params)
        return HttpResponse.json({ budget: budget({ status: 'active' }) })
      }),
    )
    const user = userEvent.setup()
    render(<GovernancePanel />)

    await user.click(await screen.findByTestId('budget-resume'))
    expect(resumeHit).toHaveBeenCalledWith({ scope: 'team', scopeId: 'team-1' })
  })
})
