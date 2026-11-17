// A goal's page: an agent's draft update is published (as is, or edited first) or
// discarded by a person, a person sets health, linked tasks open the board
// drawer, and cost says when it includes estimates.

import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { GoalDetail, GoalUpdate } from '@clawboo/control-client'

import { HOME_FIXTURE_NOW, makeGoalSummary } from '@/__vitest__/homeFixtures'
import { server } from '@/__vitest__/mswServer'
import { resetBoardPerson } from '@/features/board/useBoardPerson'
import { useFleetStore } from '@/stores/fleet'

import { GoalPage, type GoalPageActions } from '../GoalPage'

const T = { timeout: 4000 }

function update(over: Partial<GoalUpdate>): GoalUpdate {
  return {
    id: 'u1',
    goalId: 'g1',
    teamId: 't1',
    body: 'Waitlist reached 142.',
    health: 'at_risk',
    author: { kind: 'agent', id: 'a1', name: 'Maya' },
    executionId: 'e1',
    state: 'draft',
    publishedBy: null,
    publishedAt: null,
    createdAt: HOME_FIXTURE_NOW,
    ...over,
  }
}

function detail(over: Partial<GoalDetail> = {}): GoalDetail {
  return {
    summary: {
      ...makeGoalSummary(
        { id: 'g1', title: 'Launch the beta', health: 'on_track' },
        { total: 4, done: 3, doneChecked: 2, addedLast7Days: 2, doneLast7Days: 1 },
      ),
      cost: { usd: 4.82, includesEstimates: true },
    },
    parent: null,
    children: [],
    healthHistory: [],
    tasks: [
      {
        taskId: 'task-1',
        identifier: 'LAU-1',
        title: 'Write the copy',
        status: 'done',
        isMainTask: false,
        assigneeAgentId: 'a1',
        costUsd: 0.42,
        checked: true,
        linkedVia: 'own',
        dropped: false,
        createdAt: HOME_FIXTURE_NOW,
        completedAt: HOME_FIXTURE_NOW,
      },
    ],
    kpis: [],
    updates: [
      update({}),
      update({
        id: 'u0',
        state: 'published',
        publishedBy: { kind: 'person', id: 'local', name: 'You' },
        publishedAt: HOME_FIXTURE_NOW,
        body: 'Landing page live.',
        health: 'on_track',
      }),
    ],
    pages: [],
    ...over,
  }
}

function actions(): GoalPageActions {
  return {
    back: vi.fn(),
    openGoal: vi.fn(),
    openTask: vi.fn(),
    openKpi: vi.fn(),
    openPage: vi.fn(),
    addPage: vi.fn(),
    addKpi: vi.fn(),
    addChildGoal: vi.fn(),
    editGoal: vi.fn(),
    changed: vi.fn(),
  }
}

function renderPage(a = actions()) {
  render(
    <GoalPage
      teamId="t1"
      teamName="Launch"
      goalId="g1"
      now={HOME_FIXTURE_NOW}
      names={{ meId: 'local', agentName: (id) => (id === 'a1' ? 'Maya' : null) }}
      reloadKey={0}
      actions={a}
    />,
  )
  return a
}

beforeEach(() => {
  resetBoardPerson()
  useFleetStore.setState({ agents: [] })
  server.use(
    http.get('/api/home/teams/:teamId/goals/:goalId', () => HttpResponse.json({ goal: detail() })),
  )
})

afterEach(cleanup)

describe('a goal page', () => {
  it('shows progress, cost with its estimate note, drafts and the published history', async () => {
    renderPage()
    expect(await screen.findByTestId('goal-title-heading', {}, T)).toHaveTextContent(
      'Launch the beta',
    )
    expect(screen.getByTestId('goal-progress')).toHaveTextContent('3 of 4 tasks done, 2 checked')
    expect(screen.getByTestId('goal-progress')).toHaveTextContent('+2 added, 1 done this week')
    expect(screen.getByTestId('goal-cost-note')).toHaveTextContent('including estimates')
    const draft = screen.getByTestId('goal-update-draft')
    expect(draft).toHaveTextContent('by Maya in a run')
    expect(draft).toHaveTextContent('Publishing sets the goal to At risk.')
    expect(screen.getByTestId('goal-update-published')).toHaveTextContent(
      'Drafted by Maya, published by you',
    )
  })

  it('publishes a draft as it stands', async () => {
    let posted: { id: string; body: unknown } | null = null
    server.use(
      http.post(
        '/api/home/teams/:teamId/updates/:updateId/publish',
        async ({ params, request }) => {
          posted = { id: String(params.updateId), body: await request.json() }
          return HttpResponse.json({
            update: update({ state: 'published' }),
            goal: detail().summary.goal,
          })
        },
      ),
    )
    const user = userEvent.setup()
    const a = renderPage()
    await user.click(await screen.findByTestId('draft-publish', {}, T))
    await waitFor(() => expect(posted).toEqual({ id: 'u1', body: {} }), T)
    await waitFor(() => expect(a.changed).toHaveBeenCalled(), T)
  })

  it('publishes a draft edited first, with the health picked', async () => {
    let body: unknown = null
    server.use(
      http.post('/api/home/teams/:teamId/updates/:updateId/publish', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({
          update: update({ state: 'published' }),
          goal: detail().summary.goal,
        })
      }),
    )
    const user = userEvent.setup()
    renderPage()
    const draft = await screen.findByTestId('goal-update-draft', {}, T)
    await user.click(within(draft).getByRole('button', { name: 'Edit' }))
    const text = within(draft).getByTestId('goal-update-body')
    await user.clear(text)
    await user.type(text, 'Waitlist reached 150.')
    await user.click(within(draft).getByRole('button', { name: 'Health with this update' }))
    await user.click(await screen.findByRole('option', { name: 'Set On track' }))
    await user.click(within(draft).getByTestId('goal-update-submit'))
    await waitFor(
      () => expect(body).toEqual({ body: 'Waitlist reached 150.', health: 'on_track' }),
      T,
    )
  })

  it('discards a draft', async () => {
    let discarded = ''
    server.use(
      http.post('/api/home/teams/:teamId/updates/:updateId/discard', ({ params }) => {
        discarded = String(params.updateId)
        return HttpResponse.json({ update: update({ state: 'discarded' }) })
      }),
    )
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByTestId('draft-discard', {}, T))
    await waitFor(() => expect(discarded).toBe('u1'), T)
  })

  it('lets a person set health directly', async () => {
    let body: unknown = null
    server.use(
      http.post('/api/home/teams/:teamId/goals/:goalId/health', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({ goal: detail().summary.goal })
      }),
    )
    const user = userEvent.setup()
    renderPage()
    await user.click(await screen.findByTestId('goal-health', {}, T))
    await user.click(await screen.findByRole('option', { name: 'Off track' }))
    await waitFor(() => expect(body).toEqual({ health: 'off_track' }), T)
  })

  it('opens a linked task in the board drawer', async () => {
    const user = userEvent.setup()
    const a = renderPage()
    const row = await screen.findByTestId('goal-task-row', {}, T)
    expect(row).toHaveTextContent('LAU-1')
    expect(row).toHaveTextContent('Checked')
    await user.click(row)
    expect(a.openTask).toHaveBeenCalledWith('task-1')
  })

  it('says so when the goal is not on the team any more', async () => {
    server.use(
      http.get('/api/home/teams/:teamId/goals/:goalId', () =>
        HttpResponse.json({ error: 'goal_not_found' }, { status: 404 }),
      ),
    )
    renderPage()
    expect(await screen.findByText(/not on Launch any more/, {}, T)).toBeInTheDocument()
  })
})
