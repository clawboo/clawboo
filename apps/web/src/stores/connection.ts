import { create } from 'zustand'
import type { ConnectionStatus as SocketStatus, GatewayClient } from '@clawboo/gateway-client'

// ─── Types ────────────────────────────────────────────────────────────────────
// The live socket's own status (`disconnected` | `connecting` | `connected` |
// `reconnecting`) plus an app-only `error` the UI surfaces distinctly from a
// transient `disconnected`.
//
// DERIVED from the client's union rather than re-listing it, so the two cannot
// drift: if the client ever gains a status, this follows automatically and the
// exhaustive switch in `features/connection/connectionStatusDisplay.ts` fails to
// compile until someone decides how to render it.
//
// `reconnecting` is mirrored from the live client by `useGatewayEvents`; see
// `features/connection/socketStatusMirror.ts` for which transitions cross over.

export type ConnectionStatus = SocketStatus | 'error'

/**
 * True while the app is inside a LIVE session — either connected, or connected
 * with the socket transiently down and the client retrying on its own backoff.
 *
 * Every app-shell / overlay gate must use this rather than `=== 'connected'`, so
 * a mid-session drop keeps the dashboard up instead of throwing the full-screen
 * connect modal (or the onboarding wizard) over a working workspace. Gates that
 * mean "the Gateway is usable RIGHT NOW" — deploying an OpenClaw team, sending on
 * an OpenClaw chat, the Runtimes health row — deliberately stay strict.
 */
export function isSessionLive(status: ConnectionStatus): boolean {
  return status === 'connected' || status === 'reconnecting'
}

// ─── Store ────────────────────────────────────────────────────────────────────

interface ConnectionStore {
  status: ConnectionStatus
  gatewayUrl: string | null
  /** Live GatewayClient instance. Null when not connected. */
  client: GatewayClient | null

  setStatus: (status: ConnectionStatus) => void
  setGatewayUrl: (url: string | null) => void
  setClient: (client: GatewayClient | null) => void
}

export const useConnectionStore = create<ConnectionStore>((set) => ({
  status: 'disconnected',
  gatewayUrl: null,
  client: null,

  setStatus: (status) => set({ status }),
  setGatewayUrl: (gatewayUrl) => set({ gatewayUrl }),
  setClient: (client) => set({ client }),
}))
