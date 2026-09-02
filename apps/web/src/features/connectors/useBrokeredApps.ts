// The apps this install has authorised at the broker.
//
// IN features/connectors RATHER THAN features/marketplace, because the graph
// needs it too and marketplace imports connectors, never the reverse.
//
// ONLY WHAT IS AUTHORISED. An app nobody has signed into cannot be given to an
// agent, so offering it would be offering a row that fails. The shelf is where
// an app gets authorised; this is only ever about handing one out.

import { useCallback, useEffect, useState } from 'react'

import { BROKERED_APPS } from '@clawboo/connector-catalog'
import { apiFetch } from '@clawboo/control-client'

import { useVisiblePolling } from '@/lib/useVisiblePolling'

/** One authorised app, in the shape a picker row needs. */
export interface BrokeredApp {
  /** The broker's own name for it. A grant is keyed on this, not on `slug`. */
  toolkit: string
  slug: string
  name: string
  description: string
}

async function read(): Promise<BrokeredApp[] | null> {
  try {
    const res = await apiFetch('/api/connectors/composio')
    if (!res.ok) return null
    const body = (await res.json()) as { connected?: string[] }
    const connected = new Set(body.connected ?? [])
    return BROKERED_APPS.filter((a) => connected.has(a.slug)).map((a) => ({
      toolkit: a.toolkit,
      slug: a.slug,
      name: a.name,
      description: a.description,
    }))
  } catch {
    return null
  }
}

/**
 * The authorised apps, refreshed on focus.
 *
 * A read that FAILS leaves the last answer standing rather than reporting none:
 * a momentary server restart must not make the picker forget every app the
 * operator has connected.
 */
export function useBrokeredApps(): { apps: BrokeredApp[]; refresh: () => void } {
  const [apps, setApps] = useState<BrokeredApp[]>([])

  const refresh = useCallback(() => {
    void read().then((next) => {
      if (next) setApps(next)
    })
  }, [])
  useEffect(refresh, [refresh])

  // Authorising an app happens on the broker's page, in another tab, so focus is
  // the signal that a new one may exist.
  useVisiblePolling(refresh, 120_000, { refreshOnFocus: true })

  return { apps, refresh }
}
