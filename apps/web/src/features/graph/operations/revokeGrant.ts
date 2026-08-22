// Detach — revoke ONE grant (J5). No dialog: the 8-second undo window is the
// safety, which is honest because detach never touches tokens (the drawer's
// uninstall is the only verb that does, and it gets the typed confirmation).
//
// Reachable only from a grant-backed tile's toolbar, which renders only when the
// record carries a grantId — so this can target the grants API for the
// same reason `grantConnector.ts` can: by the time any user can click it, the
// endpoint exists.

import { apiFetch } from '@clawboo/control-client'
import { useToastStore } from '@/stores/toast'
import { useGraphStore } from '../store'

async function post(path: string): Promise<boolean> {
  try {
    // apiFetch, not fetch: the dashboard can be served under a URL path prefix,
    // so a hardcoded absolute `/api/...` would miss the base entirely.
    const res = await apiFetch(path, { method: 'POST' })
    return res.ok
  } catch {
    return false
  }
}

export async function detachGrant(display: {
  grantId: string
  connectorName: string
  /** Display name. Omit when the caller only has an id — the copy adapts. */
  agentName?: string
}): Promise<void> {
  const ok = await post(`/api/grants/${encodeURIComponent(display.grantId)}/revoke`)
  if (!ok) {
    useToastStore.getState().addToast({
      message: `Could not detach ${display.connectorName}. Nothing changed.`,
      type: 'error',
    })
    return
  }

  useGraphStore.getState().triggerRefresh()
  useToastStore.getState().addToast({
    message: display.agentName
      ? `${display.connectorName} detached from ${display.agentName}.`
      : `${display.connectorName} detached.`,
    type: 'info',
    ttlMs: 8000,
    action: {
      label: 'Undo',
      onAction: () => {
        void post(`/api/grants/${encodeURIComponent(display.grantId)}/resume`).then((restored) => {
          useGraphStore.getState().triggerRefresh()
          useToastStore.getState().addToast(
            restored
              ? { message: 'Restored.', type: 'success' }
              : {
                  message: `Could not restore ${display.connectorName}. Grant it again from its tile.`,
                  type: 'error',
                },
          )
        })
      },
    },
  })
}
