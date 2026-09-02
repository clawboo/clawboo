// The long tail, loaded only when somebody asks for it.
//
// The curated 19 are statically imported so the shelf renders with no fetch and
// no loading state, which is what an offline `npx clawboo` promises. The registry
// snapshot is 400 entries, roughly 68 KB gzipped, and is worth nothing until a
// user scrolls past the divider or a curated search misses, so it arrives through
// `await import()` at that moment and never on first paint.
//
// Loaded ONCE per session and held. A second search must not re-parse 400 entries.
//
// WHY THIS IS A CHUNK AND NOT A FETCH, when the agent and team catalog next door
// is the opposite. The two are verified at the only point where verification can
// mean anything for each, and that point differs because the bytes come from
// different places.
//
// A catalog pack LEAVES the tarball. It arrives at runtime from a remote that can
// change after release, so the server digest-checks it before parsing and the
// browser talks only to that same-origin API. Runtime integrity is the only check
// available there.
//
// This snapshot IS the shipped artifact. It is generated, committed, and compiled
// in, so it is content-addressed before publish instead: `verify:connectors`
// recomputes the digest in `scripts/lib/connector-snapshot.ts` over the file's
// canonical form and fails CI on a hand edit that preserves shape, which is
// exactly what an edited argv would preserve. Checking it again in the browser
// would verify the bundle against itself.
//
// Moving it behind the catalog's fetched seam would therefore buy no integrity
// and would cost the offline guarantee above. If it ever moves, it should be for
// tarball size, and the long tail becomes network-dependent when it does.

import { useCallback, useEffect, useState, useRef } from 'react'
import type { ConnectorDefinition } from '@clawboo/connector-catalog'

let cached: readonly ConnectorDefinition[] | null = null
let inFlight: Promise<readonly ConnectorDefinition[]> | null = null
/** The last load threw. Distinct from "loaded and empty", which never happens. */
let failed = false

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
      failed = true
      return []
    })
  return inFlight
}

export interface CommunityConnectors {
  entries: readonly ConnectorDefinition[]
  loading: boolean
  /**
   * The snapshot could not be loaded.
   *
   * Reported separately because "we could not read the registry" and "the
   * registry has nothing" are different facts, and rendering the first as the
   * second tells the user the long tail is empty when it was never consulted.
   */
  error: boolean
  /** Pull the snapshot in. Safe to call repeatedly. */
  request: () => void
}

export function useCommunityConnectors(wanted: boolean): CommunityConnectors {
  const [entries, setEntries] = useState<readonly ConnectorDefinition[]>(cached ?? [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(failed)

  // THE FETCH OUTLIVES THE COMPONENT. `loadCommunity` is a network read and the
  // marketplace panel is routinely closed before it lands, so the three setState
  // calls below would run against an unmounted tree. React 19 reaches for
  // `window` while scheduling that update, so in a torn-down test environment it
  // surfaces as an unhandled `ReferenceError: window is not defined` that fails
  // the whole suite while every test passes.
  const alive = useRef(true)
  useEffect(
    () => () => {
      alive.current = false
    },
    [],
  )

  const request = useCallback(() => {
    if (cached) {
      setEntries(cached)
      return
    }
    setLoading(true)
    void loadCommunity().then((next) => {
      if (!alive.current) return
      setEntries(next)
      setError(failed)
      setLoading(false)
    })
  }, [])

  useEffect(() => {
    if (wanted) request()
  }, [wanted, request])

  return { entries, loading, error, request }
}

/**
 * Search an already-loaded snapshot.
 *
 * Says nothing about whether it WAS loaded: an empty result here and a failed
 * load are different facts, and the caller distinguishes them with `error`
 * rather than by inspecting this return value.
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
