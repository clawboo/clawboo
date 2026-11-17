// Home's one read: `GET /api/home` for a team, or for All teams. Read on mount and
// on each team switch, then every 15 seconds while the tab is visible. A read that
// lands after a newer one started, or for a team no longer shown, is dropped, so a
// slow answer for the team the person just left never paints over the team they
// picked.

import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchHome, HomeRequestError, type HomeResponse } from '@clawboo/control-client'

import { useVisiblePolling } from '@/lib/useVisiblePolling'

export const HOME_POLL_MS = 15_000

export type HomeLoad =
  | { state: 'loading' }
  | { state: 'ready'; data: HomeResponse }
  /** `missing`: this engine has no Home routes (an older one). `teamGone`: the
   *  server has no such team (deleted since), so Home goes back to All teams. */
  | { state: 'error'; missing: boolean; teamGone: boolean }

/** The team (or `all`) a read is for. */
function readFor(data: HomeResponse): string {
  return data.scope === 'team' ? data.home.team.id : 'all'
}

export function useHome(teamId: string): { load: HomeLoad; refresh: () => Promise<void> } {
  const [load, setLoad] = useState<HomeLoad>({ state: 'loading' })
  const seq = useRef(0)
  // The team on screen now. A refresh made for another team (a write that started
  // before a switch, say) does nothing, so it can neither show that team nor drop the
  // read under way for this one.
  const current = useRef(teamId)

  const refresh = useCallback(async () => {
    if (teamId !== current.current) return
    const id = ++seq.current
    try {
      const data = await fetchHome(teamId)
      if (id !== seq.current || teamId !== current.current) return
      setLoad({ state: 'ready', data })
    } catch (err) {
      if (id !== seq.current || teamId !== current.current) return
      const known = err instanceof HomeRequestError
      const teamGone = known && err.code === 'team_not_found'
      const failed: HomeLoad = {
        state: 'error',
        missing: known && err.status === 404 && !teamGone,
        teamGone,
      }
      // A failed poll keeps this team's sections on screen; anything else (a first
      // read, or a return to a team whose sections are no longer held) shows the
      // error. A team that is gone is said even mid-visit, so Home can leave it.
      setLoad((prev) =>
        !teamGone && prev.state === 'ready' && readFor(prev.data) === teamId ? prev : failed,
      )
    }
  }, [teamId])

  useEffect(() => {
    current.current = teamId
    // A new team starts from the skeleton, never the last team's sections.
    setLoad((prev) =>
      prev.state === 'ready' && readFor(prev.data) === teamId ? prev : { state: 'loading' },
    )
    void refresh()
  }, [teamId, refresh])

  useVisiblePolling(() => void refresh(), HOME_POLL_MS)

  return { load, refresh }
}
