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

/** The signed device fields a connect frame carries (Ed25519 device auth). */
export interface GatewayDeviceField {
  id: string
  publicKey: string
  signature: string
  signedAt: number
  nonce?: string
}

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
  /**
   * Optional device-auth signer for NON-browser (Node) callers. The browser path
   * signs internally via `crypto.subtle` + localStorage (`buildDeviceConnectFields`);
   * a Node client has neither, so it injects this hook instead. When provided, the
   * client calls it with the assembled connect params + the server challenge nonce
   * and uses the returned device field (skipping the browser signing path).
   * Pair with `disableDeviceAuth: true` so the browser path never runs.
   * The server wires this to the proxy's `signConnectParams(identity, params, nonce)`.
   */
  signConnect?: (
    params: Record<string, unknown>,
    nonce: string | null,
  ) => Promise<{ device: GatewayDeviceField }>
  /**
   * The `Origin` to present on the WebSocket handshake. A browser sets Origin
   * automatically from the page and CANNOT override it, so this is a NON-browser
   * (Node) hook only — used by the server-side AgentSource connection, which must
   * present an allowed Origin or the Gateway rejects the connect with
   * `CONTROL_UI_ORIGIN_NOT_ALLOWED`. Requires `webSocketImpl`: the Node global
   * (undici) WebSocket follows the WHATWG signature and drops a custom Origin; the
   * `ws` package honours `new WebSocket(url, { origin })`.
   */
  origin?: string
  /**
   * A WebSocket constructor to use instead of the ambient global. Browser callers
   * omit it (the DOM `WebSocket` is used). Node callers that need a custom `origin`
   * pass the `ws` package's `WebSocket`.
   */
  webSocketImpl?: WebSocketLikeCtor
}

/**
 * A WebSocket constructor compatible with both the browser global and the `ws`
 * package. The optional second arg is an options bag (`{ origin }`) that `ws`
 * honours; the browser global ignores a non-string second arg, so the no-origin
 * call path stays safe across both.
 */
export type WebSocketLikeCtor = new (url: string, options?: { origin?: string }) => WebSocket

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
