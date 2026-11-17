// Home's reads follow the team on screen: a refresh made for a team the person has
// left does nothing, a return to a team whose read fails says so rather than
// waiting forever, a poll waits for a slow read instead of replacing it, and a
// team's done and dropped goals never show on another team and are read again when
// its active goals change.

import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { emptyTeamHome, makeGoalSummary } from '@/__vitest__/homeFixtures'
import { server } from '@/__vitest__/mswServer'

import { useClosedGoals } from '../useClosedGoals'
import { HOME_POLL_MS, useHome, type HomeLoad } from '../useHome'

// Home's 15 s poll runs when the test says, not on a timer.
const poll = vi.hoisted(() => ({ tick: null as null | (() => void) }))
vi.mock('@/lib/useVisiblePolling', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/useVisiblePolling')>()
  return {
    ...actual,
    useVisiblePolling: (
      tick: () => void,
      intervalMs: number,
      options?: Parameters<typeof actual.useVisiblePolling>[2],
    ) => {
      if (intervalMs === 15_000) poll.tick = tick
      else actual.useVisiblePolling(tick, intervalMs, options)
    },
  }
})

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

  it('lets a slow read land rather than replacing it with each poll', async () => {
    expect(HOME_POLL_MS).toBe(15_000)
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let reads = 0
    server.use(
      http.get('/api/home', async ({ request }) => {
        reads += 1
        const teamId = new URL(request.url).searchParams.get('teamId') ?? 'x'
        // The first read is slower than the poll.
        if (reads === 1) await gate
        return HttpResponse.json({ scope: 'team', home: emptyTeamHome(teamId) })
      }),
    )
    const { result } = renderHook(() => useHome('tA'))
    await waitFor(() => expect(reads).toBe(1), T)
    act(() => poll.tick?.())
    act(() => poll.tick?.())
    expect(reads).toBe(1)
    release()
    await waitFor(() => expect(shownTeam(result.current.load)).toBe('tA'), T)
    // Once it has landed, polls read again.
    act(() => poll.tick?.())
    await waitFor(() => expect(reads).toBe(2), T)
  })

  it('still lets a refresh after a write replace a slow read', async () => {
    let release!: () => void
    const gate = new Promise<void>((r) => (release = r))
    let reads = 0
    server.use(
      http.get('/api/home', async () => {
        reads += 1
        const home = emptyTeamHome('tA', reads === 1 ? 'Before' : 'After')
        if (reads === 1) await gate
        return HttpResponse.json({ scope: 'team', home })
      }),
    )
    const { result } = renderHook(() => useHome('tA'))
    await waitFor(() => expect(reads).toBe(1), T)
    await act(async () => {
      await result.current.refresh()
    })
    expect(reads).toBe(2)
    const name = () =>
      result.current.load.state === 'ready' && result.current.load.data.scope === 'team'
        ? result.current.load.data.home.team.name
        : null
    await waitFor(() => expect(name()).toBe('After'), T)
    await act(async () => {
      release()
      await new Promise((r) => setTimeout(r, 30))
    })
    expect(name()).toBe('After')
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
    const { result, rerender } = renderHook(({ teamId }) => useClosedGoals(teamId, 0, 'g1'), {
      initialProps: { teamId: 'tA' },
    })
    await waitFor(() => expect(result.current.map((g) => g.goal.id)).toEqual(['done-tA']), T)
    rerender({ teamId: 'tB' })
    expect(result.current).toEqual([])
    releaseB()
    await waitFor(() => expect(result.current.map((g) => g.goal.id)).toEqual(['done-tB']), T)
  })

  it('reads again when the active goals change, and not on a snapshot that changes nothing', async () => {
    let reads = 0
    let doneIds = ['g9']
    server.use(
      http.get('/api/home/teams/:teamId/goals', () => {
        reads += 1
        return HttpResponse.json({
          goals: doneIds.map((id) => makeGoalSummary({ id, teamId: 'tA', status: 'done' })),
        })
      }),
    )
    const { result, rerender } = renderHook(
      ({ active }: { active: string | null }) => useClosedGoals('tA', 0, active),
      { initialProps: { active: null as string | null } },
    )
    // Nothing is read before Home's snapshot.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(reads).toBe(0)
    rerender({ active: 'g1,g2' })
    await waitFor(() => expect(result.current.map((g) => g.goal.id)).toEqual(['g9']), T)
    // A poll with the same active goals.
    rerender({ active: 'g1,g2' })
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20))
    })
    expect(reads).toBe(1)
    // Someone marked g2 done elsewhere: it leaves the active goals.
    doneIds = ['g9', 'g2']
    rerender({ active: 'g1' })
    await waitFor(() => expect(result.current.map((g) => g.goal.id)).toEqual(['g9', 'g2']), T)
    expect(reads).toBe(2)
  })
})
