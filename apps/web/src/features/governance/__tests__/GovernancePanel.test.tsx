// Governance dashboard: budgets + audit render on mount (incl. the read-only
// tenantId — the dormant per-tenant seam) + the resume-a-paused-budget POST. The
// embedded <ToolApprovalQueue/> now always polls /api/tools/approvals, so every
// test stubs that endpoint (msw onUnhandledRequest:'error' would fail otherwise).
// The create form picks an agent, team or board task by name and posts its id.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { server } from '../../../__vitest__/mswServer'
import { useFleetStore, type AgentState } from '@/stores/fleet'
import { useTeamStore, type Team } from '@/stores/team'
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

function agent(id: string, name: string, teamId: string | null): AgentState {
  return {
    id,
    name,
    status: 'idle',
    sessionKey: null,
    model: null,
    createdAt: null,
    streamingText: null,
    runId: null,
    lastSeenAt: null,
    teamId,
    execConfig: null,
  }
}

function team(id: string, name: string, over: Partial<Team> = {}): Team {
  return {
    id,
    name,
    icon: '📣',
    color: '#ff5555',
    colorCollectionId: null,
    templateId: null,
    agentCount: 1,
    leaderAgentId: null,
    isArchived: false,
    serverOrchestrated: true,
    ...over,
  }
}

function seedDirectory() {
  useTeamStore.setState({
    teams: [
      team('t-mkt', 'Marketing'),
      team('t-eng', 'Engineering', { icon: '🛠️' }),
      team('t-old', 'Old team', { isArchived: true }),
    ],
  })
  useFleetStore.setState({
    agents: [
      agent('a-res-mkt', 'Researcher', 't-mkt'),
      agent('a-res-eng', 'Researcher', 't-eng'),
      agent('a-solo', 'Solo', null),
    ],
  })
}

/** Stub the create POST and hand back each body it receives. */
function capturePosts() {
  const posted = vi.fn()
  server.use(
    http.post('/api/governance/budgets', async ({ request }) => {
      posted(await request.json())
      return HttpResponse.json({ budget: budget() })
    }),
  )
  return posted
}

function stubEmptyLists() {
  server.use(
    http.get('/api/governance/budgets', () => HttpResponse.json({ budgets: [] })),
    http.get('/api/governance/audit', () => HttpResponse.json({ audit: [] })),
  )
}

beforeEach(() => {
  // The embedded approval queue polls this on mount.
  server.use(http.get('/api/tools/approvals', () => HttpResponse.json({ approvals: [] })))
})
afterEach(() => {
  cleanup()
  useFleetStore.setState({ agents: [] })
  useTeamStore.setState({ teams: [] })
})

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

  it('ignores an audit response for an earlier filter prefix that lands late', async () => {
    // The agent-id filter is an undebounced input, so every keystroke fires its own
    // /api/governance/audit read. Applied by arrival order, the response for the shorter
    // prefix can land last and leave the table showing rows the filter excludes.
    let releaseShortPrefix: (() => void) | undefined
    let shortPrefixAnswered = false
    server.use(
      http.get('/api/governance/budgets', () => HttpResponse.json({ budgets: [] })),
      http.get('/api/governance/audit', async ({ request }) => {
        const agentId = new URL(request.url).searchParams.get('agentId')
        const row = (id: string, summary: string) => ({
          id,
          eventType: 'budget',
          agentId,
          taskId: null,
          teamId: null,
          tenantId: null,
          summary,
          createdAt: 0,
        })
        // Hold the one-character prefix open so it resolves AFTER the full filter's read.
        if (agentId === 'a') {
          await new Promise<void>((resolve) => {
            releaseShortPrefix = resolve
          })
          shortPrefixAnswered = true
          return HttpResponse.json({ audit: [row('stale', '{"prefix":"a"}')] })
        }
        return HttpResponse.json({ audit: [row('fresh', '{"prefix":"ab"}')] })
      }),
    )
    const user = userEvent.setup()
    render(<GovernancePanel />)
    await screen.findByTestId('governance-panel')

    // Two keystrokes → a read for 'a' (parked) and a read for 'ab' (resolves).
    await user.type(screen.getByPlaceholderText('agent id'), 'ab')
    await waitFor(() => expect(screen.getByTestId('audit-row')).toHaveTextContent('prefix'))
    await waitFor(() => expect(screen.getByTestId('audit-row')).toHaveTextContent('ab'))

    // The earlier prefix's response now lands.
    releaseShortPrefix?.()
    await waitFor(() => expect(shortPrefixAnswered).toBe(true))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0)) // flush fetch → json → setState
    })

    // The table still matches what is in the filter box.
    expect(screen.getByTestId('audit-row')).toHaveTextContent('ab')
    expect(screen.getByPlaceholderText('agent id')).toHaveValue('ab')
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

  it('names agent and team budgets, and shows the id once the agent or team is gone', async () => {
    seedDirectory()
    server.use(
      http.get('/api/governance/budgets', () =>
        HttpResponse.json({
          budgets: [
            budget({ id: 'b1', scope: 'agent', scopeId: 'a-res-mkt', tenantId: null }),
            budget({ id: 'b2', scope: 'team', scopeId: 't-old', tenantId: null }),
            budget({ id: 'b3', scope: 'agent', scopeId: 'a-deleted', tenantId: null }),
          ],
        }),
      ),
      http.get('/api/governance/audit', () => HttpResponse.json({ audit: [] })),
    )
    render(<GovernancePanel />)

    await waitFor(() => expect(screen.getAllByTestId('budget-target')).toHaveLength(3))
    const [byAgent, byTeam, gone] = screen.getAllByTestId('budget-target')
    expect(byAgent).toHaveTextContent('Researcher · Marketing')
    expect(byAgent).toHaveAttribute('title', 'a-res-mkt')
    expect(byTeam).toHaveTextContent('📣 Old team · archived')
    expect(gone).toHaveTextContent('a-deleted')
  })

  it('creates an agent budget by name and submits the agent id', async () => {
    seedDirectory()
    stubEmptyLists()
    const posted = capturePosts()
    const user = userEvent.setup()
    render(<GovernancePanel />)

    const picker = await screen.findByRole('button', { name: 'Agent' })
    expect(picker).toHaveTextContent('Choose an agent')
    await user.click(picker)
    // Two agents share a name; the team tells them apart, and search matches it.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Researcher · Engineering',
      'Researcher · Marketing',
      'Solo · no team',
    ])
    await user.type(screen.getByLabelText('Search Agent'), 'market')
    await user.click(screen.getByRole('option', { name: 'Researcher · Marketing' }))
    expect(picker).toHaveTextContent('Researcher · Marketing')

    await user.type(screen.getByPlaceholderText('warn at $'), '5')
    await user.click(screen.getByTestId('budget-create'))

    await waitFor(() =>
      expect(posted).toHaveBeenCalledWith({
        scope: 'agent',
        scopeId: 'a-res-mkt',
        limitUsdCents: 500,
        mode: 'warn',
      }),
    )
    // The form clears for the next budget.
    await waitFor(() => expect(picker).toHaveTextContent('Choose an agent'))
  })

  it('offers non-archived teams for a team budget and clears the pick when the scope changes', async () => {
    seedDirectory()
    stubEmptyLists()
    const posted = capturePosts()
    const user = userEvent.setup()
    render(<GovernancePanel />)

    // Pick an agent first: switching scope must not carry an agent id into a team budget.
    await user.click(await screen.findByRole('button', { name: 'Agent' }))
    await user.click(screen.getByRole('option', { name: 'Solo · no team' }))

    await user.click(screen.getByRole('button', { name: 'Budget scope' }))
    await user.click(screen.getByRole('option', { name: 'team' }))
    const picker = screen.getByRole('button', { name: 'Team' })
    expect(picker).toHaveTextContent('Choose a team')
    await user.click(screen.getByRole('radio', { name: 'hard cap' }))
    await user.type(screen.getByPlaceholderText('cap $'), '12.5')
    await user.click(screen.getByTestId('budget-create'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(posted).not.toHaveBeenCalled()

    await user.click(picker)
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      '🛠️ Engineering',
      '📣 Marketing',
    ])
    // The limit and mode typed above are still there; only the team was missing.
    await user.click(screen.getByRole('option', { name: '📣 Marketing' }))
    await user.click(screen.getByTestId('budget-create'))

    await waitFor(() =>
      expect(posted).toHaveBeenCalledWith({
        scope: 'team',
        scopeId: 't-mkt',
        limitUsdCents: 1250,
        mode: 'cap',
      }),
    )
  })

  it('clears a picked agent that leaves the list, and then submits nothing', async () => {
    seedDirectory()
    stubEmptyLists()
    const posted = capturePosts()
    const user = userEvent.setup()
    render(<GovernancePanel />)

    const picker = await screen.findByRole('button', { name: 'Agent' })
    await user.click(picker)
    await user.click(screen.getByRole('option', { name: 'Solo · no team' }))
    expect(picker).toHaveTextContent('Solo · no team')

    // The agent is deleted while the form holds it.
    act(() =>
      useFleetStore.setState((s) => ({ agents: s.agents.filter((a) => a.name !== 'Solo') })),
    )
    await waitFor(() => expect(picker).toHaveTextContent('Choose an agent'))

    await user.type(screen.getByPlaceholderText('warn at $'), '5')
    await user.click(screen.getByTestId('budget-create'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(posted).not.toHaveBeenCalled()
  })

  it('submits nothing until an agent is picked', async () => {
    seedDirectory()
    stubEmptyLists()
    const posted = capturePosts()
    const user = userEvent.setup()
    render(<GovernancePanel />)

    await user.type(await screen.findByPlaceholderText('warn at $'), '5')
    await user.click(screen.getByTestId('budget-create'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(posted).not.toHaveBeenCalled()
  })

  it('no longer offers the tenant scope, which nothing charges, but still shows tenant rows', async () => {
    server.use(
      http.get('/api/governance/budgets', () =>
        HttpResponse.json({
          budgets: [budget({ scope: 'tenant', scopeId: 'acme', tenantId: null })],
        }),
      ),
      http.get('/api/governance/audit', () => HttpResponse.json({ audit: [] })),
    )
    const user = userEvent.setup()
    render(<GovernancePanel />)

    expect(await screen.findByTestId('budget-target')).toHaveTextContent('acme')
    await user.click(screen.getByRole('button', { name: 'Budget scope' }))
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'agent',
      'team',
      'mission',
    ])
  })

  it('reads the board only when a mission is involved', async () => {
    const boardRead = vi.fn()
    stubEmptyLists()
    server.use(
      http.get('/api/board', () => {
        boardRead()
        return HttpResponse.json({ tasks: [] })
      }),
    )
    const user = userEvent.setup()
    render(<GovernancePanel />)

    await screen.findByRole('button', { name: 'Agent' })
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0))
    })
    expect(boardRead).not.toHaveBeenCalled()

    await user.click(screen.getByRole('button', { name: 'Budget scope' }))
    await user.click(screen.getByRole('option', { name: 'mission' }))
    await waitFor(() => expect(boardRead).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'Board task' })).toHaveTextContent(
      'No board tasks yet',
    )
  })

  it('offers top-level board tasks for a mission budget, newest first, and names mission rows', async () => {
    seedDirectory()
    server.use(
      http.get('/api/governance/budgets', () =>
        HttpResponse.json({
          budgets: [budget({ scope: 'mission', scopeId: 'task-launch', tenantId: null })],
        }),
      ),
      http.get('/api/governance/audit', () => HttpResponse.json({ audit: [] })),
      http.get('/api/board', () =>
        HttpResponse.json({
          tasks: [
            {
              id: 'task-launch',
              status: 'done',
              title: 'Plan the launch',
              teamId: 't-mkt',
              parentTaskId: null,
              updatedAt: 1,
            },
            {
              id: 'task-sub',
              status: 'todo',
              title: 'Draft the post',
              teamId: 't-mkt',
              parentTaskId: 'task-launch',
              updatedAt: 9,
            },
            {
              id: 'task-fix',
              status: 'in_progress',
              title: 'Fix the build',
              teamId: 't-eng',
              parentTaskId: null,
              updatedAt: 5,
            },
          ],
        }),
      ),
    )
    const posted = capturePosts()
    const user = userEvent.setup()
    render(<GovernancePanel />)

    await waitFor(() =>
      expect(screen.getByTestId('budget-target')).toHaveTextContent('Plan the launch · Marketing'),
    )

    await user.click(screen.getByRole('button', { name: 'Budget scope' }))
    await user.click(screen.getByRole('option', { name: 'mission' }))
    expect(screen.getByTestId('budget-mission-hint')).toHaveTextContent('top-level board task')

    await user.click(screen.getByRole('button', { name: 'Board task' }))
    // A subtask's spend is charged to the task at the top of its tree, so it isn't offered.
    expect(screen.getAllByRole('option').map((o) => o.textContent)).toEqual([
      'Fix the build · Engineering',
      'Plan the launch · Marketing',
    ])
    await user.click(screen.getByRole('option', { name: 'Fix the build · Engineering' }))
    await user.type(screen.getByPlaceholderText('warn at $'), '3')
    await user.click(screen.getByTestId('budget-create'))

    await waitFor(() =>
      expect(posted).toHaveBeenCalledWith({
        scope: 'mission',
        scopeId: 'task-fix',
        limitUsdCents: 300,
        mode: 'warn',
      }),
    )
  })

  it('says when the board tasks could not be loaded', async () => {
    stubEmptyLists()
    server.use(http.get('/api/board', () => new HttpResponse(null, { status: 500 })))
    const user = userEvent.setup()
    render(<GovernancePanel />)

    await user.click(await screen.findByRole('button', { name: 'Budget scope' }))
    await user.click(screen.getByRole('option', { name: 'mission' }))
    await waitFor(() =>
      expect(screen.getByRole('button', { name: 'Board task' })).toHaveTextContent(
        "Couldn't load board tasks",
      ),
    )
  })
})
