// The client half of the connector lifecycle.
//
// Thin on purpose. The server owns the decision about whether a connector CAN be
// connected (`connectRefusal`, shared from the catalog package), owns the spawn,
// and owns the identity a grant is keyed on. This file moves bytes and renders
// what came back.

import { apiFetch } from '@clawboo/control-client'

import { useToastStore } from '@/stores/toast'

export interface ConnectSuccess {
  connectorId: string
  /** The RESOLVED command the server actually spawned, for the operator record. */
  command: string
  tools: string[]
  skipped: { name: string; reason: string }[]
}

async function readError(res: Response): Promise<string> {
  return res
    .json()
    .then((b: { error?: string }) => b.error ?? `HTTP ${res.status}`)
    .catch(() => `HTTP ${res.status}`)
}

/** Connect a catalog connector. Returns null when the server refused. */
export async function connectConnector(
  slug: string,
  displayName: string,
): Promise<ConnectSuccess | null> {
  let res: Response
  try {
    res = await apiFetch('/api/connectors/connect', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ slug }),
    })
  } catch {
    useToastStore.getState().addToast({
      message: `Could not reach the server. ${displayName} was not connected.`,
      type: 'error',
    })
    return null
  }

  if (!res.ok) {
    // The server's refusal copy names the actual obstacle, so it is shown
    // verbatim rather than replaced with a generic failure line.
    useToastStore.getState().addToast({ message: await readError(res), type: 'error' })
    return null
  }

  const body = (await res.json()) as ConnectSuccess
  const skipped = body.skipped?.length ?? 0
  useToastStore.getState().addToast({
    // "to agents attached over HTTP" is not padding. The in-process tools server
    // a native run uses is constructed without these, so a bare "N tools
    // available" would promise something a native agent cannot reach.
    message: skipped
      ? `${displayName} connected. ${body.tools.length} tools available to agents attached over HTTP, ${skipped} skipped.`
      : `${displayName} connected. ${body.tools.length} tools available to agents attached over HTTP.`,
    type: 'success',
  })
  return body
}

/** Disconnect a connector. Returns whether it was connected in the first place. */
export async function disconnectConnector(slug: string, displayName: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/connectors/${encodeURIComponent(slug)}/disconnect`, {
      method: 'POST',
    })
    if (!res.ok) {
      useToastStore.getState().addToast({ message: await readError(res), type: 'error' })
      return false
    }
  } catch {
    useToastStore.getState().addToast({
      message: `Could not reach the server. ${displayName} is still connected.`,
      type: 'error',
    })
    return false
  }
  useToastStore.getState().addToast({
    // Says what actually happened: the process is gone, the config you pasted
    // into your own runtime is not.
    message: `${displayName} disconnected. Its process was stopped.`,
    type: 'info',
  })
  return true
}

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
