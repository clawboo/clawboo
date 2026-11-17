// Home's reads follow the team on screen: a refresh made for a team the person has
// left does nothing, a return to a team whose read fails says so rather than
// waiting forever, and a team's done and dropped goals never show on another team.

import { cleanup, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it } from 'vitest'

import { emptyTeamHome, makeGoalSummary } from '@/__vitest__/homeFixtures'
import { server } from '@/__vitest__/mswServer'

import { useClosedGoals } from '../useClosedGoals'
import { useHome, type HomeLoad } from '../useHome'

const T = { timeout: 4000 }

afterEach(cleanup)

/** The team a ready load is for, or null. */
const shownTeam = (load: HomeLoad) =>
  load.state === 'ready' && load.data.scope === 'team' ? load.data.home.team.id : null

describe('useHome', () => {
  it('ignores a refresh made for a team the person has left', async () => {
    const reads: Array<string | null> = []
    server.use(
      http.get('/api/home', ({ request }) => {
        const teamId = new URL(request.url).searchParams.get('teamId')
        reads.push(teamId)
        return HttpResponse.json({ scope: 'team', home: emptyTeamHome(teamId ?? 'x') })
      }),
    )
    const { result, rerender } = renderHook(({ teamId }) => useHome(teamId), {
      initialProps: { teamId: 'tA' },
    })
    await waitFor(() => expect(shownTeam(result.current.load)).toBe('tA'), T)
    const refreshForA = result.current.refresh
    rerender({ teamId: 'tB' })
    // A write made on team A finishes after the switch and asks for a refresh.
    await refreshForA()
    await waitFor(() => expect(shownTeam(result.current.load)).toBe('tB'), T)
    expect(reads).toEqual(['tA', 'tB'])
  })

  it('says a read failed on a return to a team whose sections are no longer held', async () => {
    let failA = false
    let releaseB!: () => void
    const gateB = new Promise<void>((r) => (releaseB = r))
    server.use(
      http.get('/api/home', async ({ request }) => {
        const teamId = new URL(request.url).searchParams.get('teamId') ?? 'x'
        if (teamId === 'tA' && failA) return HttpResponse.json({ error: 'boom' }, { status: 503 })
        if (teamId === 'tB') await gateB
        return HttpResponse.json({ scope: 'team', home: emptyTeamHome(teamId) })
      }),
    )
    const { result, rerender } = renderHook(({ teamId }) => useHome(teamId), {
      initialProps: { teamId: 'tA' },
    })
    await waitFor(() => expect(shownTeam(result.current.load)).toBe('tA'), T)
    failA = true
    // Over to B, whose read has not landed, and straight back to A, whose read fails.
    rerender({ teamId: 'tB' })
    expect(result.current.load.state).toBe('loading')
    rerender({ teamId: 'tA' })
    await waitFor(
      () => expect(result.current.load).toMatchObject({ state: 'error', missing: false }),
      T,
    )
    releaseB()
  })
})

describe('useClosedGoals', () => {
  it("never shows the last team's goals on the team picked next", async () => {
    let releaseB!: () => void
    const gateB = new Promise<void>((r) => (releaseB = r))
    server.use(
      http.get('/api/home/teams/:teamId/goals', async ({ params }) => {
        const teamId = String(params.teamId)
        if (teamId === 'tB') await gateB
        return HttpResponse.json({
          goals: [
            makeGoalSummary({ id: `active-${teamId}`, teamId }),
            makeGoalSummary({ id: `done-${teamId}`, teamId, status: 'done' }),
          ],
        })
      }),
    )
    const { result, rerender } = renderHook(({ teamId }) => useClosedGoals(teamId, 0), {
      initialProps: { teamId: 'tA' },
    })
    await waitFor(() => expect(result.current.map((g) => g.goal.id)).toEqual(['done-tA']), T)
    rerender({ teamId: 'tB' })
    expect(result.current).toEqual([])
    releaseB()
    await waitFor(() => expect(result.current.map((g) => g.goal.id)).toEqual(['done-tB']), T)
  })
})
