import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  acceptKpiSuggestion,
  addKpiValue,
  createGoal,
  fetchHome,
  getGoal,
  HomeRequestError,
  listKpiValues,
  listPages,
  publishGoalUpdate,
  resetControlClient,
  revertPage,
  setApiBase,
  setTaskGoal,
  turnOnWeeklyUpdates,
} from '../index'

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  } as unknown as Response
}

function stubFetch(body: unknown, status = 200) {
  const fn = vi.fn(async (_url: string, _init?: RequestInit) => jsonResponse(body, status))
  globalThis.fetch = fn as unknown as typeof fetch
  return fn
}

function call(fn: ReturnType<typeof stubFetch>, i = 0): { url: string; init: RequestInit } {
  const [url, init] = fn.mock.calls[i] as [string, RequestInit]
  return { url, init: init ?? {} }
}

afterEach(() => {
  resetControlClient()
  vi.restoreAllMocks()
})

describe('home client', () => {
  it('reads one team, and All teams with no team or "all"', async () => {
    const fn = stubFetch({ scope: 'all', home: {} })
    await fetchHome('team 1')
    await fetchHome()
    await fetchHome('all')
    expect(call(fn, 0).url).toBe('/api/home?teamId=team+1')
    expect(call(fn, 1).url).toBe('/api/home')
    expect(call(fn, 2).url).toBe('/api/home')
  })

  it('puts the team in the path and sends JSON bodies', async () => {
    const fn = stubFetch({ goal: { id: 'g1' } })
    setApiBase('https://host.example.com')
    await createGoal('t/1', { title: 'Ship it' })
    const { url, init } = call(fn)
    expect(url).toBe('https://host.example.com/api/home/teams/t%2F1/goals')
    expect(init.method).toBe('POST')
    expect(JSON.parse(String(init.body))).toEqual({ title: 'Ship it' })
    expect((init.headers as Record<string, string>)['Content-Type']).toBe('application/json')
  })

  it('answers null for a goal the team does not have', async () => {
    stubFetch({ ok: false, error: 'goal_not_found' }, 404)
    expect(await getGoal('t1', 'nope')).toBeNull()
  })

  it('throws a HomeRequestError with the status and code', async () => {
    stubFetch({ ok: false, error: 'person_only' }, 403)
    const err = await publishGoalUpdate('t1', 'u1').catch((e: unknown) => e)
    expect(err).toBeInstanceOf(HomeRequestError)
    expect((err as HomeRequestError).status).toBe(403)
    expect((err as HomeRequestError).code).toBe('person_only')
  })

  it('names each write route the server serves', async () => {
    const fn = stubFetch({ kpi: {}, value: {}, page: {}, values: [], pages: [] })
    await acceptKpiSuggestion('t1', 'k1', { target: 10 })
    await addKpiValue('t1', 'k1', { value: 3 })
    await revertPage('t1', 'p1', 2)
    await listKpiValues('t1', 'k1', { limit: 5 })
    await listPages('t1', { goalId: 'g1', includeArchived: true })
    await turnOnWeeklyUpdates('t1')
    await setTaskGoal('task-1', null)
    const seen = fn.mock.calls.map(([url, init]) => `${init?.method ?? 'GET'} ${url}`)
    expect(seen).toEqual([
      'POST /api/home/teams/t1/kpis/k1/accept',
      'POST /api/home/teams/t1/kpis/k1/values',
      'POST /api/home/teams/t1/pages/p1/revert',
      'GET /api/home/teams/t1/kpis/k1/values?limit=5',
      'GET /api/home/teams/t1/pages?includeArchived=true&goalId=g1',
      'POST /api/home/teams/t1/weekly-updates',
      'PATCH /api/board/task-1',
    ])
    expect(JSON.parse(String(call(fn, 6).init.body))).toEqual({ goalId: null })
  })
})
