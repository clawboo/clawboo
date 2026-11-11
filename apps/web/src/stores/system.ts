/**
 * apps/web/src/stores/system.ts
 *
 * Types for the system detection result (GET /api/system/status).
 */

// ─── API response types (mirrors GET /api/system/status) ─────────────────────

export interface NodeInfo {
  version: string
  major: number
  sufficient: boolean
  /** The range OpenClaw actually requires, so the UI never has to hardcode it. */
  required: string
  path: string
}

export interface OpenClawInfo {
  installed: boolean
  version: string | null
  path: string | null
  /** 'clawboo' for the copy in Clawboo's runtimes folder, 'path' for a global
   *  install, null when not installed. */
  source?: 'clawboo' | 'path' | null
  /** The Node.js Clawboo's copy runs on. */
  runsOnNode?: { path: string; version: string } | null
  /** How a person types `openclaw` in a terminal (the full path for Clawboo's
   *  copy, which is not on their PATH). */
  command?: string
  /** Why Clawboo's own copy cannot be used although one is on record, or null. */
  problem?: string | null
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
