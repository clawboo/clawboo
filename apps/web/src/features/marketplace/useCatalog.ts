// React bindings for the emitted catalog.
//
// `useCatalogIndex` is called by the two entry points that own a browse surface
// (MarketplacePanel and CreateTeamModal). Everything below them takes the index
// as a PROP rather than calling the hook itself: `TeamTemplateCard` renders 82
// times, and 82 independent subscriptions to the same memoized promise buys
// nothing and costs a re-render each.
//
// `useAgentBody` is for the detail sheets, which need one body and are mounted
// one at a time.

import { useCallback, useEffect, useState } from 'react'

import { loadAgentBody, loadCatalogIndex } from './catalogClient'
import type { AgentBody, CatalogIndex } from './catalogTypes'
import { SEED_INDEX } from './seed'

export interface CatalogIndexState {
  /**
   * NEVER NULL. It starts as the compiled seed - the builtin teams, which are
   * in the bundle already - so the grids render on the first frame instead of
   * flashing empty, and it stays the seed if the request fails.
   */
  index: CatalogIndex
  /** Set when `index` is the seed because the request did not land. */
  error: Error | null
  retry: () => void
}

export function useCatalogIndex(): CatalogIndexState {
  const [index, setIndex] = useState<CatalogIndex>(SEED_INDEX)
  const [error, setError] = useState<Error | null>(null)
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let live = true
    setError(null)
    // Never rejects: a failure resolves the seed plus the reason.
    void loadCatalogIndex().then((result) => {
      if (!live) return
      setIndex(result.index)
      setError(result.error)
    })
    return () => {
      live = false
    }
  }, [attempt])

  const retry = useCallback(() => setAttempt((n) => n + 1), [])
  return { index, error, retry }
}

export interface AgentBodyState {
  body: AgentBody | null
  error: Error | null
}

export function useAgentBody(id: string | null): AgentBodyState {
  const [body, setBody] = useState<AgentBody | null>(null)
  const [error, setError] = useState<Error | null>(null)

  useEffect(() => {
    if (!id) {
      setBody(null)
      return
    }
    let live = true
    setBody(null)
    setError(null)
    loadAgentBody(id).then(
      (b) => {
        if (live) setBody(b)
      },
      (e: unknown) => {
        if (live) setError(e instanceof Error ? e : new Error(String(e)))
      },
    )
    return () => {
      live = false
    }
  }, [id])

  return { body, error }
}
