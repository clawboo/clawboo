// Whether a browser connector has actually been granted to THIS agent.
//
// Why the browser view needs to ask at all: connecting a connector no longer
// hands it to the whole fleet. A connected browser reaches no agent until it is
// granted to that agent, and an ungranted tool is not even offered in
// `tools/list`. So the agent never calls it, never returns a frame, and the
// panel sits empty forever.
//
// Empty and "not yours to use" are different facts, and a viewer that renders
// them identically reads as broken. This is what lets the panel say which one it
// is looking at.

import { useEffect, useState } from 'react'
import { connectorsByCategory } from '@clawboo/connector-catalog'

import { connectorSlugFromId } from '@/features/graph/nodes/connectorTile'
import { fetchCapabilities } from '@/lib/capabilitiesClient'

/** Catalog-derived, never a hardcoded list: a browser connector added to the
 *  catalog is one this check picks up without being edited. */
const BROWSER_SLUGS: ReadonlySet<string> = new Set(
  connectorsByCategory('browser').map((c) => c.slug),
)

export type BrowserGrant =
  /** Still asking, or the request failed. Say nothing rather than guess wrong. */
  | 'unknown'
  /** This agent can reach a browser. An empty panel means it has not looked yet. */
  | 'granted'
  /** No browser connector reaches this agent, so it cannot produce a frame. */
  | 'missing'

export function useBrowserGrant(agentId: string | null, enabled = true): BrowserGrant {
  const [grant, setGrant] = useState<BrowserGrant>('unknown')

  useEffect(() => {
    if (!agentId || !enabled) {
      setGrant('unknown')
      return
    }
    let cancelled = false
    setGrant('unknown')
    void fetchCapabilities({ agentId }).then((view) => {
      if (cancelled) return
      // A failed fetch is NOT evidence of a missing grant. Staying on 'unknown'
      // keeps the panel's neutral copy rather than telling someone to grant
      // something they may already have granted.
      if (!view.ok) return
      const hasBrowser = view.records.some((r) => {
        const slug = connectorSlugFromId(r.connectorId ?? null) ?? r.sourceKey
        return BROWSER_SLUGS.has(slug)
      })
      setGrant(hasBrowser ? 'granted' : 'missing')
    })
    return () => {
      cancelled = true
    }
  }, [agentId, enabled])

  return grant
}
