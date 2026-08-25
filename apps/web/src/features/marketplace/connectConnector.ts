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
  return (await readRefusal(res)).message
}

/** A refusal, with the machine-readable reason the server sent alongside it. */
async function readRefusal(res: Response): Promise<{ message: string; reason?: string }> {
  return res
    .json()
    .then((b: { error?: string; reason?: string; detail?: string }) => ({
      // The SENTENCE, with the raw text appended only when it adds something.
      // A connect failure now arrives already translated (see
      // explainConnectFailure); `detail` is the original, kept because a real
      // spawn problem needs it and dropped when it merely repeats the sentence.
      message:
        b.error && b.detail && b.detail !== b.error
          ? `${b.error} (${b.detail.slice(0, 160)})`
          : (b.error ?? `HTTP ${res.status}`),
      ...(b.reason ? { reason: b.reason } : {}),
    }))
    .catch(() => ({ message: `HTTP ${res.status}` }))
}

/** Connect a catalog connector. Returns null when the server refused. */
export async function connectConnector(
  slug: string,
  displayName: string,
  /** Called when the server refuses because the stored authorization is no
   *  longer usable, so the caller can offer sign-in again. */
  onNeedsSignIn?: () => void,
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
    const body = await readRefusal(res)
    useToastStore.getState().addToast({ message: body.message, type: 'error' })
    // A stored token the provider has since revoked reads as authorized locally
    // and is refused here. Reporting the reason is what lets the panel offer
    // sign-in again instead of leaving the operator with a button that always
    // fails and no way back.
    if (body.reason === 'remote-needs-oauth') onNeedsSignIn?.()
    return null
  }

  const body = (await res.json()) as ConnectSuccess
  const skipped = body.skipped?.length ?? 0
  useToastStore.getState().addToast({
    // No longer qualified by transport. The in-process tools server a native run
    // builds now takes the same connector tools an HTTP-attached agent sees, so
    // naming one of the two would be the inaccurate half.
    message: skipped
      ? `${displayName} connected. ${body.tools.length} tools available to your agents, ${skipped} skipped.`
      : `${displayName} connected. ${body.tools.length} tools available to your agents.`,
    type: 'success',
  })
  return body
}

/** Disconnect a connector. Returns whether it was connected in the first place. */
export async function disconnectConnector(
  slug: string,
  displayName: string,
  /** Whether this connector is remote. Decides what the toast may claim was
   *  stopped: a remote connector has no process on this machine. */
  remote = false,
): Promise<boolean> {
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
    // Says what actually happened, which differs by transport: a local connector
    // had a process to stop, a remote one never had one. Claiming otherwise told
    // the operator a child had been killed on their machine when the connector
    // had only ever been an HTTP session.
    message: remote
      ? `${displayName} disconnected. Your sign-in is kept until you sign out.`
      : `${displayName} disconnected. Its process was stopped.`,
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
  /** What the vendor calls this. The field label; `key` is the env var name. */
  label?: string
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
  /** Environment variables the server needs, so the operator is actually asked. */
  authInputs?: { key: string; description: string; required: boolean }[]
  /** Registry identity, when this came from the community snapshot. */
  catalogId?: string
  /** The exact version the operator was shown before approving. */
  pinnedVersion?: string
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
  // Opened WITHOUT `noopener`, because that feature makes window.open return
  // null by specification -- which made the whole pre-open dead code and left
  // the real open happening after the await, exactly where a popup blocker
  // catches it. The handle is needed to navigate the tab once the URL arrives.
  // `opener` is neutralised below instead.
  const tab = window.open('about:blank', '_blank')
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
  if (tab) {
    // Sever the back-reference before navigating: the provider's page must not
    // be able to reach back into this one.
    tab.opener = null
    tab.location.href = authorizeUrl
  } else {
    // The pre-open was blocked anyway. This one usually is too, so the URL is
    // surfaced rather than silently lost.
    const opened = window.open(authorizeUrl, '_blank', 'noopener,noreferrer')
    if (!opened) {
      useToastStore.getState().addToast({
        message: `Your browser blocked the sign-in window. Allow pop-ups for clawboo and try again.`,
        type: 'error',
      })
      return false
    }
  }

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

export interface PathSuggestion {
  label: string
  path: string
}

/**
 * Real paths the server verified exist, for a connector that takes one.
 *
 * Empty on any failure: the text field is the fallback and it is always there,
 * so a suggestion request is never worth an error state of its own.
 */
export async function fetchPathSuggestions(slug: string): Promise<PathSuggestion[]> {
  try {
    const res = await apiFetch(`/api/connectors/path-suggestions?slug=${encodeURIComponent(slug)}`)
    if (!res.ok) return []
    const body = (await res.json()) as { suggestions?: PathSuggestion[] }
    return body.suggestions ?? []
  } catch {
    return []
  }
}
