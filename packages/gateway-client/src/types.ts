// ─── Frame types ──────────────────────────────────────────────────────────────

export type ReqFrame = {
  type: 'req'
  id: string
  method: string
  params: unknown
}

export type ResFrame = {
  type: 'res'
  id: string
  ok: boolean
  payload?: unknown
  error?: {
    code: string
    message: string
    details?: unknown
    retryable?: boolean
    retryAfterMs?: number
  }
}

export type GatewayStateVersion = {
  presence: number
  health: number
}

export type EventFrame = {
  type: 'event'
  event: string
  payload?: unknown
  seq?: number
  stateVersion?: GatewayStateVersion
}

export type Frame = ReqFrame | ResFrame | EventFrame

export type GatewayHelloOk = {
  type: 'hello-ok'
  protocol: number
  features?: { methods?: string[]; events?: string[] }
  snapshot?: unknown
  auth?: {
    deviceToken?: string
    role?: string
    scopes?: string[]
    issuedAtMs?: number
  }
  policy?: { tickIntervalMs?: number }
}

// ─── Typed domain types ───────────────────────────────────────────────────────

export type AgentStatus = 'idle' | 'running' | 'error' | 'sleeping'

export interface Agent {
  id: string
  name: string
  status?: AgentStatus
  sessionKey?: string
  model?: string
  createdAt?: number
}

export interface AgentListEntry {
  id: string
  name?: string
  identity?: {
    name?: string
    theme?: string
    emoji?: string
    avatar?: string
    avatarUrl?: string
  }
}

export interface AgentsListResult {
  defaultId: string
  mainKey: string
  scope?: string
  agents: AgentListEntry[]
}

export interface AgentCreateConfig {
  name: string
  workspace: string
}

export interface AgentCreateResult {
  agentId: string
  name: string
  workspace?: string
}

export interface Session {
  key: string
  agentId: string
  createdAt?: number
  updatedAt?: number
}

export interface GatewayConfig {
  /** Path to the gateway's config file on disk — used to derive workspace dirs. */
  path?: string
  gateway?: {
    url?: string
    token?: string
  }
  [key: string]: unknown
}

// ─── Connection types ─────────────────────────────────────────────────────────

export type ConnectionStatus = 'disconnected' | 'connecting' | 'connected' | 'reconnecting'

export type GatewayGapInfo = { expected: number; received: number }

export interface ConnectOptions {
  clientName?: string
  clientVersion?: string
  token?: string
  password?: string
  authScopeKey?: string
  disableDeviceAuth?: boolean
  platform?: string
  mode?: string
  instanceId?: string
}

// ─── Session patch types ──────────────────────────────────────────────────────

export type SessionPatchResult = {
  ok: true
  key: string
  entry?: { thinkingLevel?: string }
  resolved?: { modelProvider?: string; model?: string }
}

// ─── Forward reference for GatewayClient (used in helper param types) ─────────

export type GatewayClientLike = {
  call<T = unknown>(method: string, params?: unknown): Promise<T>
}

export type SyncSessionSettingsParams = {
  client: GatewayClientLike
  sessionKey: string
  model?: string | null
  thinkingLevel?: string | null
  execHost?: 'sandbox' | 'gateway' | 'node' | null
  execSecurity?: 'deny' | 'allowlist' | 'full' | null
  execAsk?: 'off' | 'on-miss' | 'always' | null
}

export type AutoRetryDelayParams = {
  status: ConnectionStatus
  didAutoConnect: boolean
  wasManualDisconnect: boolean
  gatewayUrl: string
  errorMessage: string | null
  connectErrorCode: string | null
  attempt: number
}
