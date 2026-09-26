// Refresh the graph when similarity edges may have come into existence:
// indexing wrote vectors, or the payload on screen predates the index. A
// refresh re-lays the graph and clears the selection, the search highlight and
// any hidden cluster, so while the user is in the middle of one of those it is
// offered (`linksReady`) rather than done to them.

import { useCallback, useEffect, useRef, useState } from 'react'

import type { EmbeddingStatus } from '@/lib/memoryClient'

import { payloadPredatesIndex, useEmbeddingPoller } from '../useEmbeddingStatus'
import { useMemoryGraphStore } from './store'

/** How long to wait before trying a failed refresh again. */
const RETRY_AFTER_MS = 5_000

export interface NewLinksRefresh {
  embedding: EmbeddingStatus | null
  /** New links are ready but the user is busy; show an explicit refresh. */
  linksReady: boolean
  refreshNow: () => void
}

export function useNewLinksRefresh(): NewLinksRefresh {
  const payload = useMemoryGraphStore((s) => s.payload)
  const payloadVersion = useMemoryGraphStore((s) => s.payloadVersion)
  const [linksReady, setLinksReady] = useState(false)
  /** The payload a refresh was last asked for: one request per payload. */
  const refreshedFrom = useRef<number | null>(null)

  const refreshForNewLinks = useCallback(() => {
    const s = useMemoryGraphStore.getState()
    const interacting =
      s.selectedNodeId != null || s.egoHits != null || s.hiddenCommunities.size > 0
    if (interacting) setLinksReady(true)
    else if (refreshedFrom.current !== s.payloadVersion) {
      refreshedFrom.current = s.payloadVersion
      s.bumpRefresh()
    }
  }, [])

  // The guard holds only while that refresh is out: once the fetch ends, a
  // failed one included, a later signal may ask again. A refresh this hook
  // asked for that failed is tried once more a few seconds later, so one
  // blip does not leave the new links off the graph.
  useEffect(() => {
    let retried = false
    let timer: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = useMemoryGraphStore.subscribe((s, prev) => {
      if (!(prev.loading && !s.loading)) return
      const asked = refreshedFrom.current != null
      const before = prev.payloadVersion
      refreshedFrom.current = null
      // The fetch sets its outcome right after it stops loading.
      queueMicrotask(() => {
        const now = useMemoryGraphStore.getState()
        const failed = now.error != null && now.payloadVersion === before
        if (!failed) {
          // Caught up by any route (Try again, a settle): no retry is owed.
          retried = false
          if (timer) clearTimeout(timer)
          timer = null
          return
        }
        if (asked && !retried) {
          retried = true
          timer = setTimeout(refreshForNewLinks, RETRY_AFTER_MS)
        }
      })
    })
    return () => {
      unsubscribe()
      if (timer) clearTimeout(timer)
    }
  }, [refreshForNewLinks])

  const embedding = useEmbeddingPoller(refreshForNewLinks)
  useEffect(() => {
    setLinksReady(false)
  }, [payloadVersion])

  // The dependency is the boolean, so this fires once per transition into
  // staleness, never in a loop.
  const payloadStale = payloadPredatesIndex(embedding, payload)
  useEffect(() => {
    if (payloadStale) refreshForNewLinks()
  }, [payloadStale, refreshForNewLinks])

  const refreshNow = useCallback(() => useMemoryGraphStore.getState().bumpRefresh(), [])
  return { embedding, linksReady, refreshNow }
}
