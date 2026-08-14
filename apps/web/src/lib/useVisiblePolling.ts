import { useEffect, useRef } from 'react'

// Visibility-aware refresh primitives. Two related problems, one module:
//
//   1. Every interval poller in the SPA (board 5 s, runtimes/fleet/scheduler 8 s,
//      obs 5 s × 5 fetches, …) kept firing on its timer in a backgrounded tab, so
//      a window nobody was looking at went on hitting the local API forever.
//      `useVisiblePolling` CLEARS the interval while `document.hidden` — rather
//      than firing and discarding — and catches up once on the way back, so a
//      hidden tab costs zero requests and a re-selected one is fresh instantly.
//   2. `GitHubStarButton` and `useUpdateCheck` had each hand-rolled the same
//      focus + `visibilitychange` refetch listener. `useRefreshOnVisible` is that
//      pattern, extracted once.
//
// Neither hook fires on mount. Every call site already owns an initial-load
// effect, so an extra call here would double-fetch on first render.

/** Window `focus` and `visibilitychange` BOTH fire when a tab is re-selected, so
 *  a naive listener pair refreshes twice. Collapse anything landing inside this
 *  window into one call. */
const RESUME_DEDUPE_MS = 300

function coalesce(run: () => void): () => void {
  let lastRunAt = Number.NEGATIVE_INFINITY
  return () => {
    const now = Date.now()
    if (now - lastRunAt < RESUME_DEDUPE_MS) return
    lastRunAt = now
    run()
  }
}

export interface VisiblePollingOptions {
  /** Set `false` to make the hook completely inert — no interval, no listeners.
   *  Call sites that only poll in some states need this: a hook cannot sit behind
   *  an early return, so the condition has to come in as an option. */
  enabled?: boolean
  /** Also refresh when the window regains focus without a visibility change. An
   *  OS-level app switch back to an already-visible tab never fires
   *  `visibilitychange`, so surfaces where the user fixes something in another
   *  app and tabs back (a provider key, say) want this. */
  refreshOnFocus?: boolean
}

/**
 * Run `tick` every `intervalMs`, but only while the tab is visible.
 *
 * On `visibilitychange` → hidden the interval is cleared outright; on the way
 * back `tick` runs once immediately and the interval restarts.
 */
export function useVisiblePolling(
  tick: () => void,
  intervalMs: number,
  options: VisiblePollingOptions = {},
): void {
  const { enabled = true, refreshOnFocus = false } = options

  // Reach the callback through a ref. Call sites pass inline arrows, so
  // depending on `tick` directly would tear down and restart the timer on every
  // render — a panel that re-renders faster than its interval would never tick.
  const tickRef = useRef(tick)
  useEffect(() => {
    tickRef.current = tick
  })

  useEffect(() => {
    if (!enabled) return

    let timer: number | null = null
    const start = (): void => {
      if (timer === null) timer = window.setInterval(() => tickRef.current(), intervalMs)
    }
    const stop = (): void => {
      if (timer !== null) {
        window.clearInterval(timer)
        timer = null
      }
    }
    // Deliberately outside the coalescer: a hide→show flicker inside the dedupe
    // window may skip the catch-up call, but it must never skip the restart, or
    // the poller would stay stopped for the life of the mount.
    const catchUp = coalesce(() => tickRef.current())
    const resume = (): void => {
      if (document.hidden) return
      catchUp()
      start()
    }
    const onVisibilityChange = (): void => {
      if (document.hidden) stop()
      else resume()
    }

    if (!document.hidden) start()
    document.addEventListener('visibilitychange', onVisibilityChange)
    if (refreshOnFocus) window.addEventListener('focus', resume)

    return () => {
      stop()
      document.removeEventListener('visibilitychange', onVisibilityChange)
      if (refreshOnFocus) window.removeEventListener('focus', resume)
    }
  }, [enabled, intervalMs, refreshOnFocus])
}

/**
 * Run `refresh` whenever the tab comes back to the user — on window focus and on
 * `visibilitychange` → visible. No timer: this is for surfaces that are cheap to
 * re-check on return but have no reason to poll on a cadence.
 */
export function useRefreshOnVisible(
  refresh: () => void,
  options: { enabled?: boolean } = {},
): void {
  const { enabled = true } = options

  const refreshRef = useRef(refresh)
  useEffect(() => {
    refreshRef.current = refresh
  })

  useEffect(() => {
    if (!enabled) return

    const onResume = coalesce(() => refreshRef.current())
    const handle = (): void => {
      if (document.hidden) return
      onResume()
    }
    window.addEventListener('focus', handle)
    document.addEventListener('visibilitychange', handle)

    return () => {
      window.removeEventListener('focus', handle)
      document.removeEventListener('visibilitychange', handle)
    }
  }, [enabled])
}
