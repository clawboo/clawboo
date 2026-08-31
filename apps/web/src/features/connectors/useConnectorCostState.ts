// What every connector currently costs, read once and shared.
//
// TWO SURFACES NEED THIS, and they used to disagree. The connectors shelf reads
// live and configured state and prices each card from both; the in-chat ask card
// priced from the bare definition alone, so a connector whose key the operator
// stored last week was offered in chat as "Add key" while the shelf two clicks
// away said "Turn on". Same predicate, same inputs, or the product contradicts
// itself in front of the person deciding whether to trust it.
//
// OUTSIDE features/marketplace ON PURPOSE. The marketplace is behind a lazy
// boundary so its catalogs stay out of first paint, and `entryImportGraph.test`
// fails the build if the eager graph reaches that directory at all. The chat
// panel is eager, so the shared piece lives here and the marketplace imports it,
// never the other way round.

import { useCallback, useEffect, useRef, useState } from 'react'
import { apiFetch } from '@clawboo/control-client'
import {
  connectorCost,
  type ConnectorCost,
  type ConnectorDefinition,
} from '@clawboo/connector-catalog'

/** Slugs running right now. Empty on any failure: absence reads as "not live". */
async function fetchLive(): Promise<ReadonlySet<string>> {
  try {
    const res = await apiFetch('/api/connectors')
    if (!res.ok) return new Set()
    const body = (await res.json()) as { connectors?: { slug: string }[] }
    return new Set((body.connectors ?? []).map((c) => c.slug))
  } catch {
    return new Set()
  }
}

/**
 * Two different facts about every connector, in one request.
 *
 * `satisfied` is "it has what it asked for", which is what the price tag needs.
 * `supplied` is "a person put something into this one", which is what the
 * "Yours" filter needs. They are NOT the same: a connector that asks for
 * nothing is satisfied the moment it exists, and listing those as the
 * operator's own turned that filter into a second copy of "Ready now".
 *
 * ONE request for the whole set. Per-connector would be a round-trip per card
 * on a surface whose whole point is that it renders instantly from committed
 * data.
 */
async function fetchConfigured(): Promise<{
  satisfied: ReadonlySet<string>
  supplied: ReadonlySet<string>
}> {
  try {
    const res = await apiFetch('/api/connectors/configured')
    if (!res.ok) return { satisfied: new Set(), supplied: new Set() }
    const body = (await res.json()) as { slugs?: string[]; supplied?: string[] }
    return { satisfied: new Set(body.slugs ?? []), supplied: new Set(body.supplied ?? []) }
  } catch {
    // A failed read means "not known", and `connectorCost` treats that as the
    // cost CLASS rather than as unconfigured, so the surface degrades to
    // typical instead of to wrong.
    return { satisfied: new Set(), supplied: new Set() }
  }
}

export interface ConnectorCostState {
  costOf: (def: ConnectorDefinition) => ConnectorCost
  /** Whether this slug is running right now. */
  isLive: (slug: string) => boolean
  /**
   * Whether the operator has stored something for this slug.
   *
   * A key or a folder they supplied, not a connector that happens to need
   * nothing: "mine" means I put something into this one.
   */
  isConfigured: (slug: string) => boolean
  refresh: () => void
}

export function useConnectorCostState(): ConnectorCostState {
  // A GENERATION, because two untracked fetches race each other and the network.
  // Connecting something fires a refresh while an earlier one is still in
  // flight; if the earlier response lands second it restores the pre-connect
  // snapshot, and the card goes back to offering Connect for something already
  // running. Applied to BOTH reads together so live and configured can never be
  // rendered from two different moments.
  const generationRef = useRef(0)
  const [live, setLive] = useState<ReadonlySet<string>>(new Set())
  const [configured, setConfigured] = useState<{
    satisfied: ReadonlySet<string>
    supplied: ReadonlySet<string>
  }>({ satisfied: new Set(), supplied: new Set() })

  const refresh = useCallback(() => {
    const generation = ++generationRef.current
    // SETTLED SEPARATELY, NOT TOGETHER. `Promise.all` held every answer behind
    // the slowest one, so the whole shelf rendered late whenever a single read
    // was slow. Each lands as it arrives, behind the same generation guard.
    void fetchLive().then((next) => {
      if (generation === generationRef.current) setLive(next)
    })
    void fetchConfigured().then((next) => {
      if (generation === generationRef.current) setConfigured(next)
    })
  }, [])
  useEffect(refresh, [refresh])

  const costOf = useCallback(
    (def: ConnectorDefinition): ConnectorCost =>
      connectorCost(def, {
        connected: live.has(def.slug),
        // Only assert configured when the read succeeded and named this slug.
        // Absence is "not known", not "unconfigured": see fetchConfigured.
        ...(configured.satisfied.has(def.slug) ? { configured: true } : {}),
      }),
    [live, configured],
  )

  const isLive = useCallback((slug: string) => live.has(slug), [live])
  const isConfigured = useCallback((slug: string) => configured.supplied.has(slug), [configured])

  return { costOf, isLive, isConfigured, refresh }
}
