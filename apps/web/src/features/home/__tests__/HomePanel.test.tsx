// Home: the team picker starts on the sidebar's team, a team's sections come in
// the spec's order and hide when empty, a team with nothing yet gets first-run
// prompts, every KPI says where its value came from, All teams switches the
// picker, and the rail and goal chips reach it through the view store.

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
  useTeamStore.setState({ teams: teams as never, selectedTeamId: 't1' })
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

    await user.click(screen.getByRole('button', { name: 'Open Support Home' }))
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
    expect(screen.getByTestId('home-status-source')).toHaveTextContent('Computed from the board')
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

describe('when Home cannot be read', () => {
  it('says this server has no Home when the route is missing', async () => {
    server.use(
      http.get('/api/home', () => HttpResponse.json({ error: 'not_found' }, { status: 404 })),
    )
    render(<HomePanel />)
    expect(await screen.findByText('Home is not available here', {}, T)).toBeInTheDocument()
  })
})
