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
