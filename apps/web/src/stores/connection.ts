import { create } from 'zustand'
import type { GatewayClient } from '@clawboo/gateway-client'

// ─── Types ────────────────────────────────────────────────────────────────────
// Superset of @clawboo/gateway-client's ConnectionStatus — adds 'error' state
// that the UI surfaces distinctly from transient 'disconnected'.

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'error'

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
