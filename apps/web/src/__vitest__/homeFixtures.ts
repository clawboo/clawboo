// Home's default request mocks for component tests, and builders for the shapes
// `@clawboo/control-client`'s home.ts describes.
//
// Every read Home makes answers here with an empty team (or an empty All
// teams), so a test that mounts Home, a goal page or a board drawer with a goal
// picker does not trip `onUnhandledRequest: 'error'`. Writes have no default: a
// test that clicks one registers its own handler and asserts on the body. A test
// that needs data overrides a read with `server.use(...)`, building it from the
// helpers below so the shape stays the contract's.

import type {
  AllTeamsHome,
  GoalProgress,
  GoalSummary,
  HomeNeedsYou,
  HomeSpend,
  HomeStatusLine,
  KpiReading,
  KpiTile,
  TeamGoal,
  TeamHome,
  TeamHomeSettings,
  TeamKpi,
  TeamPage,
} from '@clawboo/control-client'
import { http, HttpResponse } from 'msw'

export const HOME_FIXTURE_NOW = 1_763_300_000_000

export function emptyNeedsYou(): HomeNeedsYou {
  return { total: 0, tasks: [], approvals: 0, questions: 0, draftUpdates: [], suggestedKpis: [] }
}

export function emptySpend(): HomeSpend {
  return { last7DaysUsd: 0, last30DaysUsd: 0, includesEstimates: false, budget: null }
}

export function computedStatus(text = 'Nothing in flight.'): HomeStatusLine {
  return {
    text,
    source: 'computed',
    asOf: HOME_FIXTURE_NOW,
    author: null,
    executionId: null,
    model: null,
    facts: {
      requestsInFlight: 0,
      needsYou: 0,
      doneLast7Days: 0,
      spentLast7DaysUsd: 0,
      budgetLimitUsd: null,
      budgetSpentUsd: null,
    },
  }
}

export function defaultHomeSettings(): TeamHomeSettings {
  return { leadWritesStatus: false, weeklyUpdatesRoutineId: null }
}

export function emptyTeamHome(teamId: string, name = 'Team'): TeamHome {
  return {
    team: { id: teamId, name, icon: null, color: null, leaderAgentId: null },
    asOf: HOME_FIXTURE_NOW,
    status: computedStatus(),
    settings: defaultHomeSettings(),
    needsYou: emptyNeedsYou(),
    goals: [],
    kpis: [],
    inFlight: [],
    spend: emptySpend(),
    routines: [],
    pinnedPages: [],
    recentFiles: [],
  }
}

export function emptyAllTeamsHome(): AllTeamsHome {
  return {
    asOf: HOME_FIXTURE_NOW,
    teams: [],
    totals: {
      requestsInFlight: 0,
      needsYou: 0,
      doneLast7Days: 0,
      spentLast7DaysUsd: 0,
      goalsActive: 0,
      goalsAtRisk: 0,
      goalsOffTrack: 0,
    },
    needsYou: emptyNeedsYou(),
  }
}

export function makeGoal(overrides: Partial<TeamGoal> = {}): TeamGoal {
  return {
    id: 'goal-1',
    teamId: 'team-1',
    parentGoalId: null,
    title: 'Launch the beta',
    description: '',
    owner: null,
    targetDate: null,
    status: 'active',
    health: null,
    healthSetBy: null,
    healthSetAt: null,
    updateCadenceDays: 7,
    position: 0,
    createdBy: { kind: 'person', id: 'local', name: 'You' },
    createdAt: HOME_FIXTURE_NOW,
    updatedAt: HOME_FIXTURE_NOW,
    archivedAt: null,
    ...overrides,
  }
}

export function makeGoalSummary(
  goal: Partial<TeamGoal> = {},
  progress: Partial<GoalProgress> = {},
): GoalSummary {
  return {
    goal: makeGoal(goal),
    progress: {
      total: 0,
      done: 0,
      doneChecked: 0,
      addedLast7Days: 0,
      doneLast7Days: 0,
      ...progress,
    },
    cost: { usd: 0, includesEstimates: false },
    lastUpdateAt: null,
    updateMissing: false,
    draftCount: 0,
    childCount: 0,
  }
}

export function makeKpi(overrides: Partial<TeamKpi> = {}): TeamKpi {
  return {
    id: 'kpi-1',
    teamId: 'team-1',
    goalId: null,
    name: 'Signups',
    unit: 'signups',
    direction: 'up',
    target: null,
    period: 'week',
    source: 'person',
    metric: null,
    reporterAgentId: null,
    staleAfterHours: null,
    status: 'active',
    suggestedBy: null,
    suggestionNote: null,
    createdBy: { kind: 'person', id: 'local', name: 'You' },
    position: 0,
    createdAt: HOME_FIXTURE_NOW,
    updatedAt: HOME_FIXTURE_NOW,
    ...overrides,
  }
}

export function makeKpiTile(
  kpi: Partial<TeamKpi> = {},
  reading: Partial<KpiReading> = {},
): KpiTile {
  const made = makeKpi(kpi)
  return {
    kpi: made,
    reading: {
      value: null,
      asOf: null,
      source: made.source,
      periodStart: null,
      latest: null,
      freshness: made.source === 'computed' ? 'ok' : 'missing',
      ...reading,
    },
  }
}

export function makePage(overrides: Partial<TeamPage> = {}): TeamPage {
  return {
    id: 'page-1',
    teamId: 'team-1',
    goalId: null,
    title: 'Notes',
    pinned: false,
    archivedAt: null,
    createdAt: HOME_FIXTURE_NOW,
    updatedAt: HOME_FIXTURE_NOW,
    revision: 1,
    updatedBy: { kind: 'person', id: 'local', name: 'You' },
    ...overrides,
  }
}

/** Read-only defaults for every Home route. */
export const homeHandlers = [
  http.get('/api/home', ({ request }) => {
    const teamId = new URL(request.url).searchParams.get('teamId')
    return teamId
      ? HttpResponse.json({ scope: 'team', home: emptyTeamHome(teamId) })
      : HttpResponse.json({ scope: 'all', home: emptyAllTeamsHome() })
  }),
  http.get('/api/home/teams/:teamId/goals', () => HttpResponse.json({ goals: [] })),
  http.get('/api/home/teams/:teamId/goals/:goalId', () =>
    HttpResponse.json({ ok: false, error: 'goal_not_found' }, { status: 404 }),
  ),
  http.get('/api/home/teams/:teamId/goals/:goalId/updates', () =>
    HttpResponse.json({ updates: [] }),
  ),
  http.get('/api/home/teams/:teamId/kpis', () => HttpResponse.json({ kpis: [] })),
  http.get('/api/home/teams/:teamId/kpis/:kpiId/values', () => HttpResponse.json({ values: [] })),
  http.get('/api/home/teams/:teamId/pages', () => HttpResponse.json({ pages: [] })),
  http.get('/api/home/teams/:teamId/pages/:pageId', () =>
    HttpResponse.json({ ok: false, error: 'page_not_found' }, { status: 404 }),
  ),
  http.get('/api/home/teams/:teamId/pages/:pageId/revisions', () =>
    HttpResponse.json({ revisions: [] }),
  ),
  http.get('/api/home/teams/:teamId/settings', () =>
    HttpResponse.json({ settings: defaultHomeSettings() }),
  ),
]
