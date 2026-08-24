// The long tail, loaded only when somebody asks for it.
//
// The curated 19 are statically imported so the shelf renders with no fetch and
// no loading state, which is what an offline `npx clawboo` promises. The registry
// snapshot is roughly 220 KB and is worth nothing until a user scrolls past the
// divider or a curated search misses, so it arrives through `await import()` at
// that moment and never on first paint.
//
// Loaded ONCE per session and held. A second search must not re-parse 229 entries.

import { useCallback, useEffect, useState } from 'react'
import type { ConnectorDefinition } from '@clawboo/connector-catalog'

let cached: readonly ConnectorDefinition[] | null = null
let inFlight: Promise<readonly ConnectorDefinition[]> | null = null

/**
 * The community snapshot, fetched from the separate bundle entry.
 *
 * Shared across every caller, because two components asking at once would
 * otherwise pull the chunk twice.
 */
async function loadCommunity(): Promise<readonly ConnectorDefinition[]> {
  if (cached) return cached
  inFlight ??= import('@clawboo/connector-catalog/community')
    .then((m) => {
      cached = m.COMMUNITY_SNAPSHOT
      return cached
    })
    .catch(() => {
      // A failed chunk load must not take the shelf down. The curated directory
      // is the part that has to work offline, and it is already rendered.
      inFlight = null
      return []
    })
  return inFlight
}

export interface CommunityConnectors {
  entries: readonly ConnectorDefinition[]
  loading: boolean
  /** Pull the snapshot in. Safe to call repeatedly. */
  request: () => void
}

export function useCommunityConnectors(wanted: boolean): CommunityConnectors {
  const [entries, setEntries] = useState<readonly ConnectorDefinition[]>(cached ?? [])
  const [loading, setLoading] = useState(false)

  const request = useCallback(() => {
    if (cached) {
      setEntries(cached)
      return
    }
    setLoading(true)
    void loadCommunity().then((next) => {
      setEntries(next)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (wanted) request()
  }, [wanted, request])

  return { entries, loading, request }
}

/**
 * Search the snapshot without pulling it in.
 *
 * Returns null when it has not been loaded, which the caller renders as "nothing
 * here yet" rather than as "no results": those are different facts and conflating
 * them would tell a user the registry has nothing when it has not been consulted.
 */
export function searchCommunity(
  entries: readonly ConnectorDefinition[],
  query: string,
): ConnectorDefinition[] {
  const q = query.trim().toLowerCase()
  if (!q) return [...entries]
  return entries.filter(
    (c) =>
      c.displayName.toLowerCase().includes(q) ||
      c.slug.includes(q) ||
      c.description.toLowerCase().includes(q),
  )
}
