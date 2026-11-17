// Home: the team picker starts on the sidebar's team, a team's sections come in
// the spec's order and hide when empty, a team with nothing yet gets first-run
// prompts, every KPI says where its value came from, All teams switches the
// picker, and the rail and goal chips reach it through the view store. Done and
// dropped goals stay folded or open across a goal page, and only the newest
// suggestion asked for opens.

import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { AllTeamsHome, KpiValue, TeamHome } from '@clawboo/control-client'

import {
  computedStatus,
  emptyAllTeamsHome,
  emptyNeedsYou,
  emptyTeamHome,
  HOME_FIXTURE_NOW,
  makeGoalSummary,
  makeKpiTile,
  makePage,
} from '@/__vitest__/homeFixtures'
import { server } from '@/__vitest__/mswServer'
import { resetBoardPerson } from '@/features/board/useBoardPerson'
import { useFleetStore } from '@/stores/fleet'
import { resetGoalsStore } from '@/stores/goals'
import { useTeamStore } from '@/stores/team'
import { useToastStore } from '@/stores/toast'
import { useViewStore } from '@/stores/view'

import { HomePanel } from '../HomePanel'

const T = { timeout: 4000 }

const teams = [
  { id: 't1', name: 'Launch', icon: 'L', color: '#e94560', isArchived: false },
  { id: 't2', name: 'Support', icon: 'S', color: '#3b82f6', isArchived: false },
]

function value(over: Partial<KpiValue>): KpiValue {
  return {
    id: 'v1',
    kpiId: 'k',
    value: 0,
    asOf: HOME_FIXTURE_NOW,
    reportedBy: null,
    executionId: null,
    taskId: null,
    sourceUrl: null,
    note: null,
    createdAt: HOME_FIXTURE_NOW,
    ...over,
  }
}

/** A team Home with something in every section. */
function fullHome(teamId = 't1'): TeamHome {
  const now = Date.now()
  return {
    ...emptyTeamHome(teamId, 'Launch'),
    status: computedStatus('2 requests in flight, 1 needs you, 3 done this week.'),
    needsYou: {
      ...emptyNeedsYou(),
      total: 2,
      tasks: [
        {
          taskId: 'task-9',
          identifier: 'LAU-9',
          title: 'Pick a domain',
          teamId,
          reason: 'unassigned',
        },
      ],
      suggestedKpis: [
        {
          kpiId: 'k-sugg',
          name: 'Reply time',
          teamId,
          goalId: null,
          suggestedBy: { kind: 'agent', id: 'a1', name: 'Iris' },
          note: 'Users mention replies',
          createdAt: now,
        },
      ],
    },
    goals: [
      makeGoalSummary(
        { id: 'g1', teamId, title: 'Launch the beta', health: 'on_track' },
        { total: 4, done: 3, doneChecked: 2 },
      ),
      { ...makeGoalSummary({ id: 'g2', teamId, title: 'Grow the list' }), updateMissing: true },
    ],
    kpis: [
      makeKpiTile(
        {
          id: 'k1',
          teamId,
          name: 'Tasks done',
          source: 'computed',
          metric: 'tasks_done',
          unit: 'tasks',
        },
        { value: 3, asOf: now, freshness: 'ok' },
      ),
      makeKpiTile(
        { id: 'k2', teamId, name: 'Beta signups', source: 'agent', staleAfterHours: 24 },
        {
          value: 142,
          asOf: now - 30 * 3_600_000,
          freshness: 'stale',
          latest: value({ value: 142, reportedBy: { kind: 'agent', id: 'a1', name: 'Iris' } }),
        },
      ),
      makeKpiTile(
        { id: 'k3', teamId, name: 'Open rate', source: 'person', unit: '%' },
        {
          value: 31,
          asOf: now,
          freshness: 'ok',
          latest: value({ value: 31, reportedBy: { kind: 'person', id: 'local', name: 'You' } }),
        },
      ),
    ],
    inFlight: [
      {
        taskId: 'req-1',
        identifier: 'LAU-1',
        title: 'Get the beta ready',
        status: 'in_progress',
        goalId: 'g1',
        leadAgentId: null,
        subtaskCount: 6,
        subtasksDone: 4,
        createdAt: now,
        updatedAt: now,
      },
    ],
    spend: {
      last7DaysUsd: 11.42,
      last30DaysUsd: 38.9,
      includesEstimates: true,
      budget: { limitUsd: 60, spentUsd: 38.9, mode: 'cap', status: 'active' },
    },
    routines: [
      {
        id: 'r1',
        name: 'Weekly goal updates',
        target: 'team',
        agentId: null,
        nextRunAt: now + 86_400_000,
        status: 'active',
      },
    ],
    pinnedPages: [makePage({ id: 'p1', teamId, title: 'Launch checklist', pinned: true })],
    recentFiles: [
      {
        taskId: 'task-2',
        taskIdentifier: 'LAU-2',
        taskTitle: 'Write copy',
        path: 'drafts/post.md',
        sizeBytes: 2048,
        modifiedAt: now,
      },
    ],
  }
}

let reads: Array<string | null> = []

function serveHome(team: (id: string) => TeamHome, all: AllTeamsHome = emptyAllTeamsHome()) {
  server.use(
    http.get('/api/home', ({ request }) => {
      const teamId = new URL(request.url).searchParams.get('teamId')
      reads.push(teamId)
      return teamId
        ? HttpResponse.json({ scope: 'team', home: team(teamId) })
        : HttpResponse.json({ scope: 'all', home: all })
    }),
  )
}

beforeEach(() => {
  reads = []
  resetBoardPerson()
  resetGoalsStore()
  useToastStore.setState({ toasts: [] })
  useFleetStore.setState({ agents: [{ id: 'a1', name: 'Iris', teamId: 't1' }] as never })
  useTeamStore.setState({ teams: teams as never, selectedTeamId: 't1', hydrated: true })
  useViewStore.setState({ viewMode: { type: 'nav', view: 'home' }, homeFocus: null })
})

afterEach(cleanup)

describe('the team picker', () => {
  it("starts on the sidebar's team", async () => {
    serveHome((id) => emptyTeamHome(id, 'Launch'))
    render(<HomePanel />)
    expect(await screen.findByTestId('team-home', {}, T)).toBeInTheDocument()
    expect(reads).toEqual(['t1'])
    expect(screen.getByTestId('home-team-picker')).toHaveTextContent('Launch')
  })

  it('starts on All teams with no team selected, and a team card switches it', async () => {
    useTeamStore.setState({ selectedTeamId: null })
    const all = emptyAllTeamsHome()
    all.teams = [
      {
        team: { id: 't2', name: 'Support', icon: 'S', color: null, leaderAgentId: null },
        status: computedStatus('Nothing in flight.'),
        goals: [],
        kpis: [],
        needsYouCount: 0,
        spend: emptyTeamHome('t2').spend,
      },
    ]
    serveHome((id) => emptyTeamHome(id, 'Support'), all)
    const user = userEvent.setup()
    render(<HomePanel />)
    expect(await screen.findByTestId('all-teams-home', {}, T)).toBeInTheDocument()
    expect(screen.getByTestId('home-totals')).toBeInTheDocument()

    // The card's button reads as its content (name, status, numbers), not a bare label.
    const card = screen.getByRole('button', { name: /Support.*Nothing in flight\./ })
    expect(card).not.toHaveAttribute('aria-label')
    await user.click(card)
    expect(await screen.findByTestId('team-home', {}, T)).toBeInTheDocument()
    expect(reads).toEqual([null, 't2'])
    expect(screen.getByTestId('home-team-picker')).toHaveTextContent('Support')
  })

  it('switches when the rail asks for another team, and opens a goal a chip asks for', async () => {
    serveHome((id) => fullHome(id))
    server.use(
      http.get('/api/home/teams/:teamId/goals/:goalId', ({ params }) =>
        HttpResponse.json({
          goal: {
            summary: makeGoalSummary({
              id: String(params.goalId),
              teamId: 't2',
              title: 'Answer faster',
            }),
            parent: null,
            children: [],
            healthHistory: [],
            tasks: [],
            kpis: [],
            updates: [],
            pages: [],
          },
        }),
      ),
    )
    render(<HomePanel />)
    await screen.findByTestId('team-home', {}, T)

    act(() => useViewStore.getState().openHome('t2', 'g7'))
    expect(await screen.findByTestId('goal-title-heading', {}, T)).toHaveTextContent(
      'Answer faster',
    )
    expect(useViewStore.getState().homeFocus).toBeNull()
    expect(screen.getByTestId('home-team-picker')).toHaveTextContent('Support')
  })
})

describe("a team's Home", () => {
  it('shows its sections in order', async () => {
    serveHome((id) => fullHome(id))
    render(<HomePanel />)
    await screen.findByTestId('team-home', {}, T)
    const order = [
      'home-status-line',
      'home-section-needs-you',
      'home-section-goals',
      'home-section-kpis',
      'home-section-in-flight',
      'home-section-spend',
      'home-section-routines',
      'home-section-pages',
      'home-section-files',
    ].map((id) => screen.getByTestId(id))
    for (let i = 1; i < order.length; i++) {
      expect(
        order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy()
    }
    expect(screen.queryByTestId('home-first-run')).toBeNull()
    expect(screen.getByTestId('home-status-source')).toHaveTextContent(
      'Computed from the board and runs',
    )
  })

  it('hides empty sections and offers first-run prompts to a team with nothing yet', async () => {
    serveHome((id) => emptyTeamHome(id, 'Launch'))
    render(<HomePanel />)
    await screen.findByTestId('team-home', {}, T)
    expect(screen.getByTestId('home-first-run')).toBeInTheDocument()
    expect(screen.getByTestId('home-first-goal')).toBeInTheDocument()
    expect(screen.getByTestId('home-first-kpi')).toBeInTheDocument()
    expect(screen.getByTestId('home-first-page')).toBeInTheDocument()
    for (const id of [
      'needs-you',
      'goals',
      'kpis',
      'in-flight',
      'spend',
      'routines',
      'pages',
      'files',
    ]) {
      expect(screen.queryByTestId(`home-section-${id}`)).toBeNull()
    }
  })

  it('says where every KPI value came from, and marks a stale one', async () => {
    serveHome((id) => fullHome(id))
    render(<HomePanel />)
    await screen.findByTestId('team-home', {}, T)
    const tiles = screen.getAllByTestId('kpi-tile')
    const badge = (i: number) => within(tiles[i]!).getByTestId('kpi-source').textContent
    expect(badge(0)).toBe('Computed')
    expect(badge(1)).toBe('Iris')
    expect(badge(2)).toBe('You')
    expect(within(tiles[1]!).getByTestId('kpi-stale')).toBeInTheDocument()
    expect(within(tiles[0]!).queryByTestId('kpi-stale')).toBeNull()
    expect(tiles[1]).toHaveTextContent('Reported by Iris')
  })

  it('marks a goal whose update is missing', async () => {
    serveHome((id) => fullHome(id))
    render(<HomePanel />)
    await screen.findByTestId('team-home', {}, T)
    const rows = screen.getAllByTestId('home-goal-row')
    expect(within(rows[0]!).queryByTestId('goal-update-missing')).toBeNull()
    expect(within(rows[1]!).getByTestId('goal-update-missing')).toBeInTheDocument()
    expect(rows[0]).toHaveTextContent('3 of 4 tasks done, 2 checked')
  })

  it('dismisses a suggested KPI from Needs you', async () => {
    serveHome((id) => fullHome(id))
    let dismissed: string | null = null
    server.use(
      http.post('/api/home/teams/:teamId/kpis/:kpiId/dismiss', ({ params }) => {
        dismissed = `${params.teamId}/${params.kpiId}`
        return HttpResponse.json({ kpi: makeKpiTile({ id: 'k-sugg', status: 'archived' }).kpi })
      }),
    )
    const user = userEvent.setup()
    render(<HomePanel />)
    const row = await screen.findByTestId('home-needs-suggestion', {}, T)
    await user.click(within(row).getByRole('button', { name: 'Dismiss' }))
    await waitFor(() => expect(dismissed).toBe('t1/k-sugg'), T)
  })

  it("tells the person when the server's person check refuses a write", async () => {
    serveHome((id) => fullHome(id))
    server.use(
      http.post('/api/home/teams/:teamId/kpis/:kpiId/dismiss', () =>
        HttpResponse.json({ ok: false, error: 'person_only' }, { status: 403 }),
      ),
    )
    const user = userEvent.setup()
    render(<HomePanel />)
    const row = await screen.findByTestId('home-needs-suggestion', {}, T)
    await user.click(within(row).getByRole('button', { name: 'Dismiss' }))
    await waitFor(
      () =>
        expect(
          useToastStore
            .getState()
            .toasts.map((t) => t.message)
            .join(' '),
        ).toMatch(/could not tell that this came from you/),
      T,
    )
  })

  it('creates a goal from the first-run prompt and opens its page', async () => {
    serveHome((id) => emptyTeamHome(id, 'Launch'))
    let body: unknown = null
    server.use(
      http.post('/api/home/teams/:teamId/goals', async ({ request }) => {
        body = await request.json()
        return HttpResponse.json({
          goal: makeGoalSummary({ id: 'g-new', teamId: 't1', title: 'Ship it' }).goal,
        })
      }),
      http.get('/api/home/teams/:teamId/goals/:goalId', () =>
        HttpResponse.json({
          goal: {
            summary: makeGoalSummary({ id: 'g-new', teamId: 't1', title: 'Ship it' }),
            parent: null,
            children: [],
            healthHistory: [],
            tasks: [],
            kpis: [],
            updates: [],
            pages: [],
          },
        }),
      ),
    )
    const user = userEvent.setup()
    render(<HomePanel />)
    await user.click(await screen.findByTestId('home-first-goal', {}, T))
    const dialog = await screen.findByTestId('goal-dialog', {}, T)
    await user.type(within(dialog).getByTestId('goal-title'), 'Ship it')
    await user.click(within(dialog).getByTestId('goal-save'))
    await waitFor(() => expect(body).toMatchObject({ title: 'Ship it', updateCadenceDays: 7 }), T)
    expect(await screen.findByTestId('goal-title-heading', {}, T)).toHaveTextContent('Ship it')
  })
})

describe('done and dropped goals', () => {
  it('keeps them reachable in a folded list, and opens one', async () => {
    serveHome((id) => fullHome(id))
    server.use(
      http.get('/api/home/teams/:teamId/goals', () =>
        HttpResponse.json({
          goals: [
            makeGoalSummary({ id: 'g1', teamId: 't1', title: 'Launch the beta' }),
            makeGoalSummary({ id: 'g9', teamId: 't1', title: 'Pick a name', status: 'done' }),
            makeGoalSummary({ id: 'g8', teamId: 't1', title: 'Run ads', status: 'dropped' }),
          ],
        }),
      ),
      http.get('/api/home/teams/:teamId/goals/:goalId', ({ params }) =>
        HttpResponse.json({
          goal: {
            summary: makeGoalSummary({
              id: String(params.goalId),
              teamId: 't1',
              title: 'Pick a name',
              status: 'done',
            }),
            parent: null,
            children: [],
            healthHistory: [],
            tasks: [],
            kpis: [],
            updates: [],
            pages: [],
          },
        }),
      ),
    )
    const user = userEvent.setup()
    render(<HomePanel />)
    const toggle = await screen.findByTestId('home-closed-goals-toggle', {}, T)
    expect(toggle).toHaveTextContent('Done and dropped2')
    expect(toggle).toHaveAttribute('aria-expanded', 'false')
    await user.click(toggle)
    const list = screen.getByTestId('home-closed-goals')
    const rows = within(list).getAllByTestId('home-goal-row')
    expect(rows.map((r) => within(r).getByTestId('goal-status').textContent)).toEqual([
      'Done',
      'Dropped',
    ])
    await user.click(rows[0]!)
    expect(await screen.findByTestId('goal-title-heading', {}, T)).toHaveTextContent('Pick a name')
  })

  it('stays open on the way back from a goal, with focus on its row', async () => {
    serveHome((id) => fullHome(id))
    server.use(
      http.get('/api/home/teams/:teamId/goals', () =>
        HttpResponse.json({
          goals: [
            makeGoalSummary({ id: 'g9', teamId: 't1', title: 'Pick a name', status: 'done' }),
          ],
        }),
      ),
      http.get('/api/home/teams/:teamId/goals/:goalId', ({ params }) =>
        HttpResponse.json({
          goal: {
            summary: makeGoalSummary({
              id: String(params.goalId),
              teamId: 't1',
              title: 'Pick a name',
              status: 'done',
            }),
            parent: null,
            children: [],
            healthHistory: [],
            tasks: [],
            kpis: [],
            updates: [],
            pages: [],
          },
        }),
      ),
    )
    const user = userEvent.setup()
    render(<HomePanel />)
    await user.click(await screen.findByTestId('home-closed-goals-toggle', {}, T))
    const list = screen.getByTestId('home-closed-goals')
    await user.click(within(list).getByTestId('home-goal-row'))
    await screen.findByTestId('goal-title-heading', {}, T)
    await user.click(screen.getByTestId('goal-back'))
    expect(await screen.findByTestId('home-closed-goals-toggle', {}, T)).toHaveAttribute(
      'aria-expanded',
      'true',
    )
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-goal-id', 'g9'), T)
  })

  it('shows no list when every goal is active', async () => {
    serveHome((id) => fullHome(id))
    let listed = false
    server.use(
      http.get('/api/home/teams/:teamId/goals', () => {
        listed = true
        return HttpResponse.json({
          goals: [makeGoalSummary({ id: 'g1', teamId: 't1', title: 'Launch the beta' })],
        })
      }),
    )
    render(<HomePanel />)
    await screen.findByTestId('team-home', {}, T)
    await waitFor(() => expect(listed).toBe(true), T)
    // Let the answer land before saying the list is absent.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(screen.queryByTestId('home-closed-goals-toggle')).toBeNull()
  })
})

describe('when the team goes away', () => {
  it('falls back to All teams when the last team was deleted', async () => {
    useTeamStore.setState({ teams: [], selectedTeamId: null, hydrated: true })
    useViewStore.setState({ homeFocus: { teamId: 't1', goalId: null, nonce: 1 } })
    serveHome((id) => emptyTeamHome(id, 'Launch'))
    render(<HomePanel />)
    // All teams, with no teams to show: its empty state, not the dead team's Home.
    expect(await screen.findByText('No teams yet', {}, T)).toBeInTheDocument()
    expect(reads[reads.length - 1]).toBeNull()
    expect(screen.queryByTestId('team-home')).toBeNull()
  })

  it('waits for the team list before deciding a team is gone', async () => {
    useTeamStore.setState({ teams: [], selectedTeamId: 't1', hydrated: false })
    serveHome((id) => emptyTeamHome(id, 'Launch'))
    render(<HomePanel />)
    await waitFor(() => expect(reads).toEqual(['t1']), T)
    act(() => useTeamStore.getState().hydrateTeams(teams as never))
    expect(await screen.findByTestId('team-home', {}, T)).toBeInTheDocument()
  })

  it('falls back to All teams when the server says the team is gone', async () => {
    server.use(
      http.get('/api/home', ({ request }) => {
        const teamId = new URL(request.url).searchParams.get('teamId')
        reads.push(teamId)
        return teamId
          ? HttpResponse.json({ ok: false, error: 'team_not_found' }, { status: 404 })
          : HttpResponse.json({ scope: 'all', home: emptyAllTeamsHome() })
      }),
    )
    render(<HomePanel />)
    await waitFor(() => expect(reads).toEqual(['t1', null]), T)
    expect(screen.queryByText('Home is not available here')).toBeNull()
    expect(screen.getByTestId('home-team-picker')).toHaveTextContent('All teams')
  })
})

describe('focus between Home and a goal', () => {
  it("lands on the goal's title, and Back returns to its row", async () => {
    serveHome((id) => fullHome(id))
    server.use(
      http.get('/api/home/teams/:teamId/goals/:goalId', ({ params }) =>
        HttpResponse.json({
          goal: {
            summary: makeGoalSummary({
              id: String(params.goalId),
              teamId: 't1',
              title: 'Grow the list',
            }),
            parent: null,
            children: [],
            healthHistory: [],
            tasks: [],
            kpis: [],
            updates: [],
            pages: [],
          },
        }),
      ),
    )
    const user = userEvent.setup()
    render(<HomePanel />)
    await screen.findByTestId('team-home', {}, T)
    await user.click(screen.getAllByTestId('home-goal-row')[1]!)
    const heading = await screen.findByTestId('goal-title-heading', {}, T)
    await waitFor(() => expect(heading).toHaveFocus(), T)
    await user.click(screen.getByTestId('goal-back'))
    await waitFor(() => expect(document.activeElement).toHaveAttribute('data-goal-id', 'g2'), T)
  })
})

describe('when Home cannot be read', () => {
  it('says this server has no Home when the route is missing', async () => {
    server.use(
      http.get('/api/home', () => HttpResponse.json({ error: 'not_found' }, { status: 404 })),
    )
    render(<HomePanel />)
    expect(await screen.findByText('Home is not available here', {}, T)).toBeInTheDocument()
  })
})

/** All teams with two suggested KPIs in Needs you: Reply time on t1, Open rate on t2. */
function serveTwoSuggestions() {
  useTeamStore.setState({ selectedTeamId: null })
  const all = emptyAllTeamsHome()
  const suggestion = (kpiId: string, name: string, teamId: string) => ({
    kpiId,
    name,
    teamId,
    goalId: null,
    suggestedBy: { kind: 'agent' as const, id: 'a1', name: 'Iris' },
    note: null,
    createdAt: HOME_FIXTURE_NOW,
  })
  all.teams = teams.map((t) => ({
    team: { id: t.id, name: t.name, icon: t.icon, color: null, leaderAgentId: null },
    status: computedStatus('Nothing in flight.'),
    goals: [],
    kpis: [],
    needsYouCount: 1,
    spend: emptyTeamHome(t.id).spend,
  }))
  all.needsYou = {
    ...emptyNeedsYou(),
    total: 2,
    suggestedKpis: [suggestion('kA', 'Reply time', 't1'), suggestion('kB', 'Open rate', 't2')],
  }
  serveHome((id) => emptyTeamHome(id, 'Launch'), all)
}

describe('reviewing a suggested KPI', () => {
  it('opens the suggestion picked last, even when the first answers later', async () => {
    serveTwoSuggestions()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    server.use(
      http.get('/api/home/teams/:teamId/kpis', async ({ params }) => {
        if (params.teamId === 't1') {
          await gate
          return HttpResponse.json({
            kpis: [
              makeKpiTile({ id: 'kA', teamId: 't1', name: 'Reply time', status: 'suggested' }),
            ],
          })
        }
        return HttpResponse.json({
          kpis: [makeKpiTile({ id: 'kB', teamId: 't2', name: 'Open rate', status: 'suggested' })],
        })
      }),
    )
    const user = userEvent.setup()
    render(<HomePanel />)
    const rows = await screen.findAllByTestId('home-needs-suggestion', {}, T)
    await user.click(within(rows[0]!).getByRole('button', { name: 'Review' }))
    await user.click(within(rows[1]!).getByRole('button', { name: 'Review' }))
    const dialog = await screen.findByTestId('kpi-dialog', {}, T)
    await waitFor(() => expect(within(dialog).getByTestId('kpi-name')).toHaveValue('Open rate'), T)
    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 50))
    })
    expect(within(screen.getByTestId('kpi-dialog')).getByTestId('kpi-name')).toHaveValue(
      'Open rate',
    )
  })
})

describe('dismissing a suggested KPI from Needs you', () => {
  it('leaves a dialog opened meanwhile open when the dismissal lands late', async () => {
    serveTwoSuggestions()
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let dismissed = false
    server.use(
      http.post('/api/home/teams/:teamId/kpis/:kpiId/dismiss', async () => {
        await gate
        dismissed = true
        return HttpResponse.json({ kpi: makeKpiTile({ id: 'kA', status: 'archived' }).kpi })
      }),
      http.get('/api/home/teams/:teamId/kpis', () =>
        HttpResponse.json({
          kpis: [makeKpiTile({ id: 'kB', teamId: 't2', name: 'Open rate', status: 'suggested' })],
        }),
      ),
    )
    const user = userEvent.setup()
    render(<HomePanel />)
    const rows = await screen.findAllByTestId('home-needs-suggestion', {}, T)
    await user.click(within(rows[0]!).getByRole('button', { name: 'Dismiss' }))
    await user.click(within(rows[1]!).getByRole('button', { name: 'Review' }))
    const dialog = await screen.findByTestId('kpi-dialog', {}, T)
    await user.type(within(dialog).getByTestId('kpi-target'), '5')
    const readsBefore = reads.length
    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 50))
    })
    await waitFor(() => expect(dismissed).toBe(true), T)
    // The dismissal has landed once Home reads again after it.
    await waitFor(() => expect(reads.length).toBeGreaterThan(readsBefore), T)
    // A closed dialog stays in the page while it animates out: wait that out.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 1200))
    })
    const still = screen.getByTestId('kpi-dialog')
    expect(within(still).getByTestId('kpi-name')).toHaveValue('Open rate')
    expect(within(still).getByTestId('kpi-target')).toHaveValue('5')
  })
})
