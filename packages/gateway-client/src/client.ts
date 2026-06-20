import { createLogger } from '@clawboo/logger'
import { GatewayResponseError } from './errors'
import {
  buildDeviceConnectFields,
  handleDeviceTokenFromHello,
  clearDeviceToken,
  generateUUID,
} from './device-auth'
import { encodeConfigPatchParams } from './helpers'
import type {
  ReqFrame,
  ResFrame,
  EventFrame,
  GatewayHelloOk,
  ConnectionStatus,
  ConnectOptions,
  WebSocketLikeCtor,
  AgentsListResult,
  AgentCreateConfig,
  AgentCreateResult,
  Session,
  SessionPatchResult,
  GatewayConfig,
} from './types'

// ─── Internal types ──────────────────────────────────────────────────────────

type PendingRequest = {
  resolve: (value: unknown) => void
  reject: (err: unknown) => void
}

type StatusHandler = (status: ConnectionStatus) => void
type EventHandler = (event: EventFrame) => void

const CONNECT_FAILED_CLOSE_CODE = 4008
const WS_CLOSE_REASON_MAX_BYTES = 123

const parseConnectFailedCloseReason = (
  reason: string,
): { code: string; message: string } | null => {
  const trimmed = reason.trim()
  if (!trimmed.toLowerCase().startsWith('connect failed:')) return null
  const remainder = trimmed.slice('connect failed:'.length).trim()
  if (!remainder) return null
  const idx = remainder.indexOf(' ')
  const code = (idx === -1 ? remainder : remainder.slice(0, idx)).trim()
  if (!code) return null
  const message = (idx === -1 ? '' : remainder.slice(idx + 1)).trim()
  return { code, message: message || 'connect failed' }
}

function truncateWsCloseReason(reason: string, maxBytes = WS_CLOSE_REASON_MAX_BYTES): string {
  const trimmed = reason.trim()
  if (!trimmed) return 'connect failed'
  const encoder = new TextEncoder()
  if (encoder.encode(trimmed).byteLength <= maxBytes) return trimmed

  let out = ''
  for (const char of trimmed) {
    const next = out + char
    if (encoder.encode(next).byteLength > maxBytes) break
    out = next
  }
  return out.trimEnd() || 'connect failed'
}

const log = createLogger('gateway-client')

// ─── GatewayClient ───────────────────────────────────────────────────────────

export class GatewayClient {
  private ws: WebSocket | null = null
  private pending = new Map<string, PendingRequest>()
  private statusHandlers = new Set<StatusHandler>()
  private eventHandlers = new Set<EventHandler>()
  private _status: ConnectionStatus = 'disconnected'
  private connectTimer: ReturnType<typeof setTimeout> | null = null
  private connectSent = false
  private resolveConnect: (() => void) | null = null
  private rejectConnect: ((err: Error) => void) | null = null
  private manualDisconnect = false
  private lastHello: GatewayHelloOk | null = null

  // Reconnection state
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private backoffMs = 800
  private connectUrl = ''
  private connectOpts: ConnectOptions = {}

  // Device auth state
  private connectNonce: string | null = null
  private deviceId: string | null = null
  private canFallbackToShared = false

  // ── Connection lifecycle ────────────────────────────────────────────────────

  get status(): ConnectionStatus {
    return this._status
  }

  onStatus(handler: StatusHandler): () => void {
    this.statusHandlers.add(handler)
    handler(this._status)
    return () => this.statusHandlers.delete(handler)
  }

  onEvent(handler: EventHandler): () => void {
    this.eventHandlers.add(handler)
    return () => this.eventHandlers.delete(handler)
  }

  /** Subscribe to a specific event by name. Returns unsubscribe fn. */
  on(event: string, handler: (payload: unknown) => void): () => void {
    return this.onEvent((frame) => {
      if (frame.event === event) handler(frame.payload)
    })
  }

  getLastHello(): GatewayHelloOk | null {
    return this.lastHello
  }

  async connect(url: string, options: ConnectOptions = {}): Promise<void> {
    if (!url.trim()) throw new Error('Gateway URL is required.')
    if (this.ws) throw new Error('Gateway is already connected or connecting.')

    log.info({ url }, 'connecting to gateway')
    this.manualDisconnect = false
    this.connectUrl = url
    this.connectOpts = options
    this.backoffMs = 800
    this.updateStatus('connecting')

    return new Promise<void>((resolve, reject) => {
      this.resolveConnect = resolve
      this.rejectConnect = reject
      this.openWebSocket(url, options)
    })
  }

  disconnect(): void {
    log.info('manual disconnect requested')
    this.manualDisconnect = true

    if (this.reconnectTimer !== null) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }

    if (!this.ws) {
      this.updateStatus('disconnected')
      return
    }

    this.ws.close()
    this.ws = null
    this.flushPending(new Error('gateway client stopped'))
    this.clearConnectPromise()
    this.updateStatus('disconnected')
    log.info('gateway disconnected')
  }

  // ── Request/response ────────────────────────────────────────────────────────

  async call<T = unknown>(method: string, params?: unknown, timeoutMs = 60_000): Promise<T> {
    if (!method.trim()) throw new Error('Gateway method is required.')
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway is not connected.')
    }

    const id = generateUUID()
    const frame: ReqFrame = { type: 'req', id, method, params }

    const promise = new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        if (this.pending.delete(id)) {
          reject(new Error(`Gateway request "${method}" timed out after ${timeoutMs}ms`))
        }
      }, timeoutMs)

      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer)
          resolve(v as T)
        },
        reject: (err) => {
          clearTimeout(timer)
          reject(err)
        },
      })
    })

    this.ws.send(JSON.stringify(frame))
    return promise
  }

  // ── Private WebSocket wiring ────────────────────────────────────────────────

  private openWebSocket(url: string, options: ConnectOptions): void {
    // Node callers (the server-side AgentSource) can inject the `ws` package's
    // WebSocket + an `origin` so the Gateway's control-ui origin check passes; the
    // ambient global undici WebSocket would drop the Origin header. Browser callers
    // pass neither and fall through to the DOM global with the page's own Origin.
    const Ctor: WebSocketLikeCtor =
      options.webSocketImpl ?? (WebSocket as unknown as WebSocketLikeCtor)
    const ws = options.origin ? new Ctor(url, { origin: options.origin }) : new Ctor(url)
    this.ws = ws

    ws.onopen = () => {
      log.debug({ url }, 'websocket opened, waiting 750ms for challenge')
      this.connectNonce = null
      this.connectSent = false
      // Delay slightly to allow server challenge events
      if (this.connectTimer !== null) clearTimeout(this.connectTimer)
      this.connectTimer = setTimeout(() => {
        this.connectTimer = null
        void this.sendConnect()
      }, 750)
    }

    ws.onmessage = (ev: MessageEvent) => {
      this.handleMessage(String(ev.data ?? ''))
    }

    ws.onclose = (ev: CloseEvent) => {
      const reason = String(ev.reason ?? '')
      log.warn({ code: ev.code, reason }, 'websocket closed')

      if (this.connectTimer !== null) {
        clearTimeout(this.connectTimer)
        this.connectTimer = null
      }
      this.ws = null

      const connectFailed =
        ev.code === CONNECT_FAILED_CLOSE_CODE ? parseConnectFailedCloseReason(reason) : null

      const err = connectFailed
        ? new GatewayResponseError({ code: connectFailed.code, message: connectFailed.message })
        : new Error(`Gateway closed (${ev.code}): ${reason}`)

      this.flushPending(err)

      if (this.rejectConnect) {
        this.rejectConnect(err)
        this.clearConnectPromise()
      }

      if (!this.manualDisconnect) {
        this.updateStatus('reconnecting')
        this.scheduleReconnect()
      } else {
        this.updateStatus('disconnected')
      }
    }

    ws.onerror = () => {
      // Close handler will fire with the error
    }
  }

  // Reconnect-regime ownership (read alongside OpenClawAgentSource.scheduleRetry):
  // GatewayClient owns reconnection after a connection that HAD opened then DROPPED
  // (this method, 800ms → 15s). The server's OpenClawAgentSource.scheduleRetry owns
  // ONLY the case where the INITIAL connect attempt threw (2s → 60s). The two are
  // gated on disjoint conditions and never fire concurrently for the same event.
  private scheduleReconnect(): void {
    if (this.manualDisconnect) return
    const delay = this.backoffMs
    this.backoffMs = Math.min(this.backoffMs * 1.7, 15_000)
    log.info({ delayMs: delay }, 'scheduling reconnect')
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      log.info({ url: this.connectUrl }, 'reconnecting to gateway')
      this.openWebSocket(this.connectUrl, this.connectOpts)
    }, delay)
  }

  private async sendConnect(): Promise<void> {
    if (this.connectSent) return
    this.connectSent = true

    const opts = this.connectOpts
    const role = 'operator'
    const scopes = ['operator.admin', 'operator.approvals', 'operator.pairing']

    // Build auth and device fields
    let auth: { token?: string; password?: string } | undefined
    let device:
      | { id: string; publicKey: string; signature: string; signedAt: number; nonce?: string }
      | undefined

    const isSecureContext =
      !opts.signConnect &&
      !opts.disableDeviceAuth &&
      typeof crypto !== 'undefined' &&
      !!crypto.subtle

    if (isSecureContext) {
      log.debug('device auth enabled, building signed connect fields')
      try {
        const fields = await buildDeviceConnectFields({
          token: opts.token ?? null,
          password: opts.password ?? null,
          authScopeKey: opts.authScopeKey ?? this.connectUrl,
          clientName: opts.clientName ?? 'clawboo-web',
          clientMode: opts.mode ?? 'webchat',
          role,
          scopes,
          nonce: this.connectNonce,
        })
        auth = fields.auth
        device = fields.device
        this.deviceId = fields.deviceId
        this.canFallbackToShared = fields.canFallbackToShared
      } catch (devErr) {
        log.warn({ err: devErr }, 'device auth failed, falling back to plain auth')
        auth =
          opts.token || opts.password ? { token: opts.token, password: opts.password } : undefined
      }
    } else {
      // No device auth — use token/password directly
      auth =
        opts.token || opts.password ? { token: opts.token, password: opts.password } : undefined
    }

    const params = {
      // OpenClaw bumped the connect protocol from 3 → 4 in 2026.5.x.
      // We advertise support for both so old (2026.3.x and earlier) and new
      // (2026.5+) Gateways both negotiate cleanly. If openclaw ever bumps to
      // 5, the install spec in apps/web/server/api/system.ts pins to ^2026.5
      // — that prevents fresh installs from grabbing an incompatible version
      // before this range is widened.
      minProtocol: 3,
      maxProtocol: 4,
      client: {
        id: opts.clientName ?? 'openclaw-control-ui',
        version: opts.clientVersion ?? '0.0.0',
        platform: opts.platform ?? 'web',
        mode: opts.mode ?? 'webchat',
        instanceId: opts.instanceId,
      },
      role,
      scopes,
      device,
      caps: [],
      auth,
    }

    // Node device-auth path: a non-browser caller (the server-side AgentSource)
    // injects a signer instead of the browser's crypto.subtle path. We sign AFTER
    // params is assembled so the signer sees the real client/role/scopes/auth.
    if (opts.signConnect) {
      try {
        const signed = await opts.signConnect(params as Record<string, unknown>, this.connectNonce)
        params.device = signed.device
      } catch (sigErr) {
        log.warn({ err: sigErr }, 'signConnect failed, forwarding without device fields')
        params.device = undefined
      }
    }

    log.debug('sending connect RPC')
    try {
      const hello = await this.call<GatewayHelloOk>('connect', params)
      this.lastHello = hello
      this.backoffMs = 800
      log.info({ protocol: hello.protocol }, 'gateway hello-ok received')

      // Store device token from hello response
      if (hello?.auth?.deviceToken && this.deviceId) {
        log.debug({ deviceId: this.deviceId }, 'storing device token from hello')
        handleDeviceTokenFromHello({
          hello,
          deviceId: this.deviceId,
          role,
          authScopeKey: opts.authScopeKey ?? this.connectUrl,
        })
      }

      this.updateStatus('connected')
      this.resolveConnect?.()
      this.clearConnectPromise()
    } catch (err) {
      log.error({ err }, 'connect RPC failed')
      // Clear device token on auth failure with fallback
      if (this.canFallbackToShared && this.deviceId) {
        log.debug({ deviceId: this.deviceId }, 'clearing device token after auth failure')
        clearDeviceToken({
          deviceId: this.deviceId,
          role,
          authScopeKey: opts.authScopeKey ?? this.connectUrl,
        })
      }

      const error = err instanceof Error ? err : new Error('connect failed')
      if (this.rejectConnect) {
        this.rejectConnect(error)
        this.clearConnectPromise()
      }

      const rawReason =
        err instanceof GatewayResponseError
          ? `connect failed: ${err.code} ${err.message}`
          : 'connect failed'
      const reason = truncateWsCloseReason(rawReason)
      this.ws?.close(CONNECT_FAILED_CLOSE_CODE, reason)
    }
  }

  private handleMessage(raw: string): void {
    let parsed: unknown
    try {
      parsed = JSON.parse(raw)
    } catch {
      return
    }

    const frame = parsed as { type?: unknown }

    if (frame.type === 'event') {
      const evt = parsed as EventFrame

      // Handle connect.challenge — extract nonce and re-send connect
      if (evt.event === 'connect.challenge') {
        const payload = evt.payload as { nonce?: unknown } | undefined
        const nonce = payload && typeof payload.nonce === 'string' ? payload.nonce : null
        if (nonce) {
          log.info('received connect.challenge with nonce, re-sending connect')
          this.connectNonce = nonce
          this.connectSent = false // allow re-send with nonce
          void this.sendConnect()
        }
        return
      }

      this.eventHandlers.forEach((h) => {
        try {
          h(evt)
        } catch (err) {
          log.error({ err, event: evt.event }, 'event handler threw')
        }
      })
      return
    }

    if (frame.type === 'res') {
      const res = parsed as ResFrame
      const pending = this.pending.get(res.id)
      if (!pending) return
      this.pending.delete(res.id)

      if (res.ok) {
        pending.resolve(res.payload)
      } else {
        if (res.error && typeof res.error.code === 'string') {
          pending.reject(
            new GatewayResponseError({
              code: res.error.code,
              message: res.error.message ?? 'request failed',
              details: res.error.details,
            }),
          )
          return
        }
        pending.reject(new Error(res.error?.message ?? 'request failed'))
      }
    }
  }

  private flushPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err)
    this.pending.clear()
  }

  private clearConnectPromise(): void {
    this.resolveConnect = null
    this.rejectConnect = null
  }

  private updateStatus(status: ConnectionStatus): void {
    log.debug({ from: this._status, to: status }, 'status transition')
    this._status = status
    this.statusHandlers.forEach((h) => h(status))
  }

  // ── Typed method helpers ────────────────────────────────────────────────────

  readonly agents = {
    list: (): Promise<AgentsListResult> => this.call<AgentsListResult>('agents.list', {}),

    // `agents.create` is the slowest known RPC because the Gateway has to
    // resolve and validate the agent's default model, which on Windows can
    // include an OpenRouter capabilities fetch that runs 30-75 seconds
    // (Windows Defender / DNS / firewall variability). Observed real
    // latencies on a fresh Windows install: 16s / 18s / 33s / 33s. We pass
    // a 2-minute timeout so the team deploy doesn't fail half-way through.
    // No-op on a fast Mac — the call returns in 2-3s and the timer never
    // fires. See v0.1.7 round-2 Windows compat fix.
    create: (config: AgentCreateConfig): Promise<AgentCreateResult> =>
      this.call<AgentCreateResult>('agents.create', config, 120_000),

    delete: (id: string): Promise<void> => this.call<void>('agents.delete', { agentId: id }),

    files: {
      read: async (agentId: string, name: string): Promise<string> => {
        const res = await this.call<{ file?: { content?: unknown; missing?: unknown } }>(
          'agents.files.get',
          { agentId, name },
        )
        const file = res?.file
        if (file && typeof file === 'object' && typeof file.content === 'string') {
          return file.content
        }
        return ''
      },

      // `agents.files.set` is fast individually but a team deploy fires it
      // 4-5 times per agent (SOUL / IDENTITY / TOOLS / AGENTS / CLAWBOO).
      // The first batch right after agents.create can pile up against the
      // Gateway's still-warming-up state machine on Windows. 2-minute
      // timeout matches agents.create — same v0.1.7 round-2 rationale.
      set: (agentId: string, name: string, content: string): Promise<void> =>
        this.call<void>('agents.files.set', { agentId, name, content }, 120_000),
    },
  }

  readonly sessions = {
    list: (agentId: string): Promise<Session[]> =>
      this.call<Session[]>('sessions.list', { agentId }),

    send: (agentId: string, message: string): Promise<void> =>
      this.call<void>('sessions.send', { agentId, message }),

    patch: (
      key: string,
      updates: {
        model?: string | null
        thinkingLevel?: string | null
        execHost?: 'sandbox' | 'gateway' | 'node' | null
        execSecurity?: 'deny' | 'allowlist' | 'full' | null
        execAsk?: 'off' | 'on-miss' | 'always' | null
      },
    ): Promise<SessionPatchResult> =>
      this.call<SessionPatchResult>('sessions.patch', { key, ...updates }),

    /**
     * Heavier session-level abort. Where `chat.abort` cancels a specific
     * `runId`, `sessions.abort` aborts whatever is currently running on
     * the session AND clears any queued/pending state.
     *
     * `runId` is optional: when omitted, the Gateway resolves the active
     * run from `key`. We use this as the runId-less fallback in the Stop
     * button path — when a user presses Stop very fast (before the first
     * streaming event has landed and populated `agent.runId`), the
     * surgical `chat.abort(sessionKey, runId)` is a no-op because we
     * don't have a runId yet; `sessions.abort(key)` still does the right
     * thing.
     *
     * Response shape mirrors `chat.abort` — `status: 'no-active-run'` is
     * a benign no-op when the session is already idle.
     */
    abort: (
      key: string,
      runId?: string,
    ): Promise<{ ok: boolean; abortedRunId?: string | null; status?: string }> =>
      this.call<{ ok: boolean; abortedRunId?: string | null; status?: string }>(
        'sessions.abort',
        runId ? { key, runId } : { key },
      ),
  }

  readonly config = {
    get: (): Promise<GatewayConfig> => this.call<GatewayConfig>('config.get'),

    // OpenClaw 2026.5.x's `config.patch` RPC requires a `{ raw: <json-string>,
    // baseHash }` envelope (it deep-merges the parsed partial AND enforces the
    // optimistic-concurrency hash from a prior `config.get`); a bare top-level key
    // like `{ mcp }` is rejected. `encodeConfigPatchParams` does the wire encoding
    // so callers keep passing a plain partial-config object + the snapshot hash.
    patch: (updates: Partial<GatewayConfig>, baseHash?: string): Promise<void> =>
      this.call<void>('config.patch', encodeConfigPatchParams(updates, baseHash)),
  }

  // ── chat namespace ────────────────────────────────────────────────────────
  // Currently only exposes `abort` (used by the chat composer's Stop button).
  // `chat.send` is still called inline via `client.call('chat.send', …)` from
  // `chatSendOperation.ts` / `groupChatSendOperation.ts` because those paths
  // need to thread `displayText` overrides through the existing pipeline.
  readonly chat = {
    /**
     * Cancel the in-flight LLM run on a session. The Gateway responds with
     * `{ ok, abortedRunId, status }`. `status: 'no-active-run'` is a benign
     * no-op when the run has already finished, so callers don't need to
     * special-case it — local state is cleared optimistically anyway.
     */
    abort: (
      sessionKey: string,
      runId: string,
    ): Promise<{ ok: boolean; abortedRunId?: string | null; status?: string }> =>
      this.call<{ ok: boolean; abortedRunId?: string | null; status?: string }>('chat.abort', {
        sessionKey,
        runId,
      }),
  }
}
