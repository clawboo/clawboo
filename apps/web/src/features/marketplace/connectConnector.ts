// The client half of the connector lifecycle.
//
// Thin on purpose. The server owns the decision about whether a connector CAN be
// connected (`connectRefusal`, shared from the catalog package), owns the spawn,
// and owns the identity a grant is keyed on. This file moves bytes and renders
// what came back.

import type { ConnectorDefinition } from '@clawboo/connector-catalog'
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

export interface CredentialStatus {
  key: string
  description: string
  required: boolean
  secret: boolean
  /** Whether a value is stored. NEVER the value: the server returns booleans. */
  present: boolean
  docsUrl?: string
}

export interface UserArgumentSpec {
  label: string
  description: string
  example: string
  replacesArg?: string
}

export interface ConnectorConfigState {
  credentials: CredentialStatus[]
  /** Whether a remote connector has a usable token. Always true for a local one. */
  authorized: boolean
  /** The stored launch argument, in full. Not a secret, and showable by design. */
  argument: string | null
  argumentSpec: UserArgumentSpec | null
  satisfied: boolean
}

/** Everything the operator must supply before this connector can run. */
export async function fetchConnectorConfig(slug: string): Promise<ConnectorConfigState | null> {
  try {
    const res = await apiFetch(`/api/connectors/${encodeURIComponent(slug)}/config`)
    if (!res.ok) return null
    return (await res.json()) as ConnectorConfigState
  } catch {
    return null
  }
}

/**
 * Store credentials. An empty string CLEARS one.
 *
 * The response reports presence, never a value, so this can never be used to
 * read back what was written.
 */
export async function saveConnectorConfig(
  slug: string,
  displayName: string,
  patch: { values?: Record<string, string>; argument?: string },
): Promise<ConnectorConfigState | null> {
  let res: Response
  try {
    res = await apiFetch(`/api/connectors/${encodeURIComponent(slug)}/config`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(patch),
    })
  } catch {
    useToastStore.getState().addToast({
      message: `Could not reach the server. ${displayName} settings were not saved.`,
      type: 'error',
    })
    return null
  }
  if (!res.ok) {
    useToastStore.getState().addToast({ message: await readError(res), type: 'error' })
    return null
  }
  const state = (await res.json()) as ConnectorConfigState
  useToastStore.getState().addToast({
    message: state.satisfied
      ? `${displayName} is configured. You can connect it now.`
      : `${displayName} settings saved.`,
    type: 'success',
  })
  return state
}

export interface CustomConnectorInput {
  slug: string
  displayName: string
  description?: string
  command: string
  args: string[]
}

/** The operator's own connector definitions, already in catalog shape. */
export async function listCustomConnectors(): Promise<ConnectorDefinition[]> {
  try {
    const res = await apiFetch('/api/connectors/custom')
    if (!res.ok) return []
    const body = (await res.json()) as { connectors?: ConnectorDefinition[] }
    return body.connectors ?? []
  } catch {
    return []
  }
}

export async function createCustomConnector(entry: CustomConnectorInput): Promise<boolean> {
  let res: Response
  try {
    res = await apiFetch('/api/connectors/custom', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(entry),
    })
  } catch {
    useToastStore.getState().addToast({
      message: 'Could not reach the server. The connector was not added.',
      type: 'error',
    })
    return false
  }
  if (!res.ok) {
    useToastStore.getState().addToast({ message: await readError(res), type: 'error' })
    return false
  }
  useToastStore.getState().addToast({
    message: `${entry.displayName} added. Connect it when you are ready.`,
    type: 'success',
  })
  return true
}

export async function deleteCustomConnector(slug: string, displayName: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/connectors/custom/${encodeURIComponent(slug)}`, {
      method: 'DELETE',
    })
    if (!res.ok) {
      useToastStore.getState().addToast({ message: await readError(res), type: 'error' })
      return false
    }
  } catch {
    useToastStore.getState().addToast({ message: 'Could not reach the server.', type: 'error' })
    return false
  }
  useToastStore.getState().addToast({
    // Says exactly what happened: the definition is gone AND the process was
    // stopped, because removing one while it ran would orphan it.
    message: `${displayName} removed. Its process was stopped.`,
    type: 'info',
  })
  return true
}

/**
 * Start an OAuth sign-in and open the provider's page.
 *
 * The window is opened from the CLICK handler, synchronously enough that the
 * browser still treats it as user-initiated: opening it after the await would be
 * caught by the popup blocker on a sign-in the user explicitly asked for.
 */
export async function signInConnector(slug: string, displayName: string): Promise<boolean> {
  const tab = window.open('', '_blank', 'noopener,noreferrer')
  let res: Response
  try {
    res = await apiFetch(`/api/connectors/${encodeURIComponent(slug)}/authorize`, {
      method: 'POST',
    })
  } catch {
    tab?.close()
    useToastStore.getState().addToast({ message: 'Could not reach the server.', type: 'error' })
    return false
  }
  if (!res.ok) {
    tab?.close()
    useToastStore.getState().addToast({ message: await readError(res), type: 'error' })
    return false
  }

  const { authorizeUrl } = (await res.json()) as { authorizeUrl: string }
  if (tab) tab.location.href = authorizeUrl
  else window.open(authorizeUrl, '_blank', 'noopener,noreferrer')

  // Block until the loopback listener sees the redirect. The server owns the
  // timeout, so a user who abandons the tab gets a clear failure rather than a
  // request that hangs forever.
  const done = await apiFetch(`/api/connectors/${encodeURIComponent(slug)}/authorize/await`, {
    method: 'POST',
  }).catch(() => null)
  if (!done?.ok) {
    useToastStore.getState().addToast({
      message: done ? await readError(done) : `${displayName} sign-in did not complete.`,
      type: 'error',
    })
    return false
  }
  useToastStore.getState().addToast({
    message: `Signed in to ${displayName}. You can connect it now.`,
    type: 'success',
  })
  return true
}

/** Forget a remote connector's tokens, and stop it if it is running. */
export async function signOutConnector(slug: string, displayName: string): Promise<boolean> {
  try {
    const res = await apiFetch(`/api/connectors/${encodeURIComponent(slug)}/authorize`, {
      method: 'DELETE',
    })
    if (!res.ok) {
      useToastStore.getState().addToast({ message: await readError(res), type: 'error' })
      return false
    }
  } catch {
    useToastStore.getState().addToast({ message: 'Could not reach the server.', type: 'error' })
    return false
  }
  useToastStore.getState().addToast({
    message: `Signed out of ${displayName}. Its tokens were deleted and the connection stopped.`,
    type: 'info',
  })
  return true
}
