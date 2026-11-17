// Home's one read: `GET /api/home` for a team, or for All teams. Read on mount and
// on each team switch, then every 15 seconds while the tab is visible. A read that
// lands after a newer one started is dropped, so a slow answer for the team the
// person just left never paints over the team they picked.

import { useCallback, useEffect, useRef, useState } from 'react'

import { fetchHome, HomeRequestError, type HomeResponse } from '@clawboo/control-client'

import { useVisiblePolling } from '@/lib/useVisiblePolling'

export const HOME_POLL_MS = 15_000

export type HomeLoad =
  | { state: 'loading' }
  | { state: 'ready'; data: HomeResponse }
  /** `missing`: this engine has no Home (an older one), or the team is gone. */
  | { state: 'error'; missing: boolean }

export function useHome(teamId: string): { load: HomeLoad; refresh: () => Promise<void> } {
  const [load, setLoad] = useState<HomeLoad>({ state: 'loading' })
  const seq = useRef(0)
  const shownFor = useRef<string | null>(null)

  const refresh = useCallback(async () => {
    const id = ++seq.current
    try {
      const data = await fetchHome(teamId)
      if (id !== seq.current) return
      shownFor.current = teamId
      setLoad({ state: 'ready', data })
    } catch (err) {
      if (id !== seq.current) return
      // A failed poll keeps what is on screen; only a first read shows the error.
      if (shownFor.current === teamId) return
      setLoad({
        state: 'error',
        missing: err instanceof HomeRequestError && err.status === 404,
      })
    }
  }, [teamId])

  useEffect(() => {
    // A new team starts from the skeleton, never the last team's sections.
    if (shownFor.current !== teamId) setLoad({ state: 'loading' })
    void refresh()
  }, [teamId, refresh])

  useVisiblePolling(() => void refresh(), HOME_POLL_MS)

  return { load, refresh }
}
