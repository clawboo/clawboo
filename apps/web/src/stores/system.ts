/**
 * apps/web/src/stores/system.ts
 *
 * Zustand store for system detection, OpenClaw installation,
 * and Gateway process control state.
 */

import { create } from 'zustand'

// ─── API response types (mirrors GET /api/system/status) ─────────────────────

export interface NodeInfo {
  version: string
  major: number
  sufficient: boolean
  path: string
}

export interface OpenClawInfo {
  installed: boolean
  version: string | null
  path: string | null
  stateDir: string
  configExists: boolean
  envExists: boolean
}

export interface GatewayInfo {
  running: boolean
  port: number
  pid: number | null
  managedByClawboo: boolean
  uptimeMs: number | null
}

export interface SystemInfo {
  node: NodeInfo
  openclaw: OpenClawInfo
  gateway: GatewayInfo
}

// ─── Status enums ────────────────────────────────────────────────────────────

export type InstallStatus = 'idle' | 'installing' | 'success' | 'error'

export type GatewayControlStatus =
  | 'idle'
  | 'starting'
  | 'stopping'
  | 'running'
  | 'stopped'
  | 'error'

// ─── Store ───────────────────────────────────────────────────────────────────

interface SystemStore {
  /** System detection result from GET /api/system/status */
  info: SystemInfo | null
  /** True while the detect fetch is in flight */
  detecting: boolean

  /** OpenClaw install progress */
  installStatus: InstallStatus
  installLog: string[]

  /** Gateway start/stop progress */
  gatewayControlStatus: GatewayControlStatus
  gatewayLog: string[]

  /** Setters */
  setInfo: (info: SystemInfo) => void
  setDetecting: (detecting: boolean) => void
  setInstallStatus: (status: InstallStatus) => void
  appendInstallLog: (line: string) => void
  clearInstallLog: () => void
  setGatewayControlStatus: (status: GatewayControlStatus) => void
  appendGatewayLog: (line: string) => void
  clearGatewayLog: () => void

  /** Reset store to initial state */
  reset: () => void
}

const INITIAL_STATE = {
  info: null as SystemInfo | null,
  detecting: false,
  installStatus: 'idle' as InstallStatus,
  installLog: [] as string[],
  gatewayControlStatus: 'idle' as GatewayControlStatus,
  gatewayLog: [] as string[],
}

export const useSystemStore = create<SystemStore>((set) => ({
  ...INITIAL_STATE,

  setInfo: (info) => set({ info }),

  setDetecting: (detecting) => set({ detecting }),

  setInstallStatus: (status) => set({ installStatus: status }),

  appendInstallLog: (line) => set((state) => ({ installLog: [...state.installLog, line] })),

  clearInstallLog: () => set({ installLog: [] }),

  setGatewayControlStatus: (status) => set({ gatewayControlStatus: status }),

  appendGatewayLog: (line) => set((state) => ({ gatewayLog: [...state.gatewayLog, line] })),

  clearGatewayLog: () => set({ gatewayLog: [] }),

  reset: () => set(INITIAL_STATE),
}))
