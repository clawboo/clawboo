// What is connected right now, read from GET /api/connectors.
//
// Its own module, outside features/marketplace, because the chat's connector
// ask card needs it and the chat is in the eager bundle, which must never reach
// the marketplace (see layout/__tests__/entryImportGraph.test.ts).

import { apiFetch } from '@clawboo/control-client'

export interface LiveConnectorRow {
  connectorId: string
  slug: string
  toolCount: number
  tools: string[]
  skipped: { name: string; reason: string }[]
}

/** Everything currently connected. */
export async function listLiveConnectors(): Promise<LiveConnectorRow[]> {
  try {
    const res = await apiFetch('/api/connectors')
    if (!res.ok) return []
    const body = (await res.json()) as { connectors?: LiveConnectorRow[] }
    return body.connectors ?? []
  } catch {
    return []
  }
}
