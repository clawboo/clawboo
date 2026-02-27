import { createLogger } from '@clawboo/logger'
import { GatewayResponseError } from './errors'
import {
  buildDeviceConnectFields,
  handleDeviceTokenFromHello,
  clearDeviceToken,
  generateUUID,
} from './device-auth'
import type {
  ReqFrame,
  ResFrame,
  EventFrame,
  GatewayHelloOk,
  ConnectionStatus,
  ConnectOptions,
  GatewayGapInfo,
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
type GapHandler = (info: GatewayGapInfo) => void

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
  private gapHandlers = new Set<GapHandler>()
  private _status: ConnectionStatus = 'disconnected'
  private lastSeq: number | null = null
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

  onGap(handler: GapHandler): () => void {
    this.gapHandlers.add(handler)
    return () => this.gapHandlers.delete(handler)
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

  async call<T = unknown>(method: string, params?: unknown): Promise<T> {
    if (!method.trim()) throw new Error('Gateway method is required.')
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      throw new Error('Gateway is not connected.')
    }

    const id = generateUUID()
    const frame: ReqFrame = { type: 'req', id, method, params }

    const promise = new Promise<T>((resolve, reject) => {
      this.pending.set(id, {
        resolve: (v) => resolve(v as T),
        reject,
      })
    })

    this.ws.send(JSON.stringify(frame))
    return promise
  }

  // ── Private WebSocket wiring ────────────────────────────────────────────────

  private openWebSocket(url: string, _options: ConnectOptions): void {
    const ws = new WebSocket(url)
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
      !opts.disableDeviceAuth && typeof crypto !== 'undefined' && !!crypto.subtle

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
      minProtocol: 3,
      maxProtocol: 3,
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

      const seq = typeof evt.seq === 'number' ? evt.seq : null
      if (seq !== null) {
        if (this.lastSeq !== null && seq > this.lastSeq + 1) {
          log.warn({ expected: this.lastSeq + 1, received: seq }, 'event sequence gap detected')
          this.gapHandlers.forEach((h) => h({ expected: this.lastSeq! + 1, received: seq }))
        }
        this.lastSeq = seq
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

    create: (config: AgentCreateConfig): Promise<AgentCreateResult> =>
      this.call<AgentCreateResult>('agents.create', config),

    delete: (id: string): Promise<void> => this.call<void>('agents.delete', { id }),

    files: {
      read: (agentId: string, name: string): Promise<string> =>
        this.call<string>('agents.files.read', { agentId, name }),

      set: (agentId: string, name: string, content: string): Promise<void> =>
        this.call<void>('agents.files.set', { agentId, name, content }),
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
  }

  readonly config = {
    get: (): Promise<GatewayConfig> => this.call<GatewayConfig>('config.get'),

    patch: (updates: Partial<GatewayConfig>): Promise<void> =>
      this.call<void>('config.patch', updates),
  }
}
