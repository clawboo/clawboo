import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { URL } from 'node:url'

import { WebSocket, WebSocketServer } from 'ws'

import {
  loadOrCreateProxyDeviceIdentity,
  signConnectParams,
  type DeviceIdentity,
} from './proxy-device-auth'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface UpstreamSettings {
  /** WebSocket URL of the upstream OpenClaw gateway. */
  url: string
  /** Bearer token to inject into the connect frame server-side. */
  token: string
}

export interface ProxyOptions {
  /** Called per connection to load the upstream gateway URL and token. */
  loadUpstreamSettings: () => Promise<UpstreamSettings>
  /** Returns true when a WS upgrade should be forwarded. Defaults to /api/gateway/ws. */
  allowWs?: (req: IncomingMessage) => boolean
  /** Structured info logger. */
  log?: (msg: string, meta?: Record<string, unknown>) => void
  /** Structured error logger. */
  logError?: (msg: string, err?: unknown) => void
  /** Upstream WS ping interval (ms). A missed pong within one interval tears the
   *  half-open connection down. Default 30s. (Config, not a feature flag.) */
  keepaliveIntervalMs?: number
  /** Cap on each connect-buffer (frames held before the other side is ready).
   *  Overflow closes the connection rather than growing unbounded. Default 512. */
  maxPendingFrames?: number
}

const DEFAULT_KEEPALIVE_INTERVAL_MS = 30_000
const DEFAULT_MAX_PENDING_FRAMES = 512

export interface GatewayProxyHandle {
  /** Pass this to `server.on('upgrade', ...)`. */
  handleUpgrade: (req: IncomingMessage, socket: Duplex, head: Buffer) => void
  /** The underlying WebSocketServer (for introspection / testing). */
  wss: WebSocketServer
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function resolvePathname(url: string | undefined): string {
  const raw = typeof url === 'string' ? url : ''
  const idx = raw.indexOf('?')
  return (idx === -1 ? raw : raw.slice(0, idx)) || '/'
}

function isObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === 'object' && !Array.isArray(value))
}

function safeJsonParse(raw: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (!isObject(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

function buildErrorResponse(id: string, code: string, message: string): string {
  return JSON.stringify({ type: 'res', id, ok: false, error: { code, message } })
}

/**
 * Check whether the connect params already contain a non-empty auth token.
 */
function hasNonEmptyToken(params: unknown): boolean {
  if (!isObject(params)) return false
  const auth = params['auth']
  if (!isObject(auth)) return false
  const token = auth['token']
  return typeof token === 'string' && token.trim().length > 0
}

/**
 * Check whether the connect params already contain a device signature
 * (browser-generated Ed25519 identity).
 */
function _hasDeviceSignature(params: unknown): boolean {
  if (!isObject(params)) return false
  const device = params['device']
  if (!isObject(device)) return false
  const sig = device['signature']
  return typeof sig === 'string' && sig.trim().length > 0
}

/**
 * Inject the server-side auth token into the connect params.
 * All other fields (device, client, nonce, etc.) are preserved as-is.
 *
 * Server-side injection is the PRIMARY path: the upstream token lives only on the
 * server and is never returned to the browser (GET /api/settings exposes a
 * `hasToken` flag, never the value), so the browser connects without a token and
 * the proxy fills it in here. If a browser ever does supply its own auth.token
 * (e.g. a remote gateway the user typed a token for), that value is preserved.
 */
function injectAuthToken(params: unknown, token: string): Record<string, unknown> {
  const next = isObject(params) ? { ...params } : {}
  const auth = isObject(next['auth']) ? { ...next['auth'] } : {}
  auth['token'] = token
  next['auth'] = auth
  return next
}

function resolveOriginForUpstream(upstreamUrl: string): string {
  const url = new URL(upstreamUrl)
  const proto = url.protocol === 'wss:' ? 'https:' : 'http:'
  const hostname =
    url.hostname === '127.0.0.1' || url.hostname === '::1' || url.hostname === '0.0.0.0'
      ? 'localhost'
      : url.hostname
  const host = url.port ? `${hostname}:${url.port}` : hostname
  return `${proto}//${host}`
}

// ─── createGatewayProxy ─────────────────────────────────────────────────────
//
// Design: upstream connection is opened *eagerly* on browser WS open, before
// any browser message arrives. This is required because the OpenClaw gateway
// sends a `connect.challenge` event spontaneously right after the TCP handshake,
// and the browser needs to receive that nonce before it can send its signed
// `connect` request with device identity.
//
// Flow:
//   1. Browser opens WS to proxy
//   2. Proxy loads settings and opens upstream immediately
//   3. Upstream sends `connect.challenge` → proxy forwards to browser
//   4. Browser sends connect frame (with device sig + nonce)
//   5. Proxy injects auth token if missing and forwards to upstream
//   6. Upstream responds with hello-ok → proxy forwards to browser
//   7. Subsequent messages are forwarded bidirectionally

export function createGatewayProxy(options: ProxyOptions): GatewayProxyHandle {
  const {
    loadUpstreamSettings,
    allowWs = (req) => resolvePathname(req.url) === '/api/gateway/ws',
    log = () => undefined,
    logError = (msg, err) => console.error(msg, err),
    keepaliveIntervalMs = DEFAULT_KEEPALIVE_INTERVAL_MS,
    maxPendingFrames = DEFAULT_MAX_PENDING_FRAMES,
  } = options

  const wss = new WebSocketServer({ noServer: true })

  // Load proxy device identity eagerly (shared across all connections)
  let proxyDeviceIdentity: DeviceIdentity | null = null
  let proxyDeviceLoading: Promise<DeviceIdentity> | null = null
  const getProxyDeviceIdentity = async (): Promise<DeviceIdentity> => {
    if (proxyDeviceIdentity) return proxyDeviceIdentity
    if (!proxyDeviceLoading) {
      proxyDeviceLoading = loadOrCreateProxyDeviceIdentity()
        .then((id) => {
          proxyDeviceIdentity = id
          log('proxy device identity loaded', { deviceId: id.deviceId })
          return id
        })
        .catch((err) => {
          logError('Failed to load proxy device identity', err)
          throw err
        })
    }
    return proxyDeviceLoading
  }
  // Start loading immediately
  void getProxyDeviceIdentity()

  wss.on('connection', (browserWs: WebSocket) => {
    let upstreamWs: WebSocket | null = null
    let upstreamReady = false
    let upstreamToken = ''
    let connectRequestId: string | null = null
    let connectResponseSent = false
    let closed = false
    // Nonce received from Gateway's connect.challenge event
    let connectNonce: string | null = null
    // Buffer for browser messages that arrive before upstream is ready
    const pendingBrowserMessages: string[] = []
    // Buffer for upstream messages that arrive before browser WS is open
    const pendingUpstreamMessages: string[] = []
    // Upstream keepalive (ping/pong) state.
    let keepaliveTimer: ReturnType<typeof setInterval> | null = null
    let awaitingPong = false

    // ── Lifecycle ────────────────────────────────────────────────────────────

    const stopKeepalive = (): void => {
      if (keepaliveTimer) {
        clearInterval(keepaliveTimer)
        keepaliveTimer = null
      }
    }

    const closeBoth = (code: number, reason: string): void => {
      if (closed) return
      closed = true
      stopKeepalive()
      try {
        browserWs.close(code, reason)
      } catch {
        /* ignore */
      }
      try {
        upstreamWs?.close(code, reason)
      } catch {
        /* ignore */
      }
    }

    // Bound a connect-buffer: queue the frame, or tear the connection down if the
    // peer is stuck/slow and the buffer has grown past its cap (never unbounded).
    const bufferOrOverflow = (queue: string[], frame: string): void => {
      if (queue.length >= maxPendingFrames) {
        logError('proxy: connect-buffer overflow — closing connection', { cap: maxPendingFrames })
        closeBoth(1011, 'clawboo.buffer_overflow')
        return
      }
      queue.push(frame)
    }

    const sendToBrowser = (data: string): void => {
      if (browserWs.readyState !== WebSocket.OPEN) return
      browserWs.send(data)
    }

    // ── Forward browser message to upstream ──────────────────────────────────

    const forwardToUpstream = (raw: string, parsed: Record<string, unknown>): void => {
      if (!upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) return

      // On connect frames: the proxy handles BOTH auth token injection and
      // device identity signing server-side. This ensures browsers without
      // registered device keys (preview, incognito) can connect successfully.
      if (parsed['type'] === 'req' && parsed['method'] === 'connect') {
        void (async () => {
          try {
            let params = isObject(parsed['params']) ? { ...parsed['params'] } : {}

            // 1. Inject auth token if browser didn't provide one
            if (!hasNonEmptyToken(params) && upstreamToken) {
              params = injectAuthToken(params, upstreamToken) as Record<string, unknown>
            }

            // 2. Sign with proxy's device identity (replaces any browser device fields)
            try {
              const identity = await getProxyDeviceIdentity()
              const { device } = await signConnectParams(identity, params, connectNonce)
              params['device'] = device
              log('proxy: signed connect frame with proxy device identity', {
                deviceId: identity.deviceId,
                hasToken: hasNonEmptyToken(params),
                hasNonce: Boolean(connectNonce),
              })
            } catch (devErr) {
              log('proxy: device signing failed, forwarding without device fields', {
                error: String(devErr),
              })
              // Strip any browser device fields that won't be valid
              delete params['device']
            }

            if (upstreamWs && upstreamWs.readyState === WebSocket.OPEN) {
              upstreamWs.send(JSON.stringify({ ...parsed, params }))
            }
          } catch (err) {
            logError('proxy: failed to process connect frame', err)
          }
        })()
        return
      }

      // All other messages forwarded as-is (re-serialise to normalise whitespace)
      upstreamWs.send(JSON.stringify(parsed))
    }

    // ── Eager upstream connection ─────────────────────────────────────────────
    // Start loading settings and opening upstream immediately, without waiting
    // for the first browser message. The upstream sends connect.challenge
    // spontaneously; we must forward it to the browser before the browser sends
    // its signed connect request.

    void (async () => {
      let upstreamUrl = ''

      try {
        const settings = await loadUpstreamSettings()
        upstreamUrl = typeof settings.url === 'string' ? settings.url.trim() : ''
        upstreamToken = typeof settings.token === 'string' ? settings.token.trim() : ''
        log('proxy settings loaded', {
          upstreamUrl,
          hasToken: upstreamToken.length > 0,
          tokenLength: upstreamToken.length,
        })
      } catch (err) {
        logError('Failed to load upstream gateway settings.', err)
        closeBoth(1011, 'clawboo.settings_load_failed')
        return
      }

      if (!upstreamUrl) {
        closeBoth(1011, 'clawboo.gateway_url_missing')
        return
      }

      // Note: empty token is allowed for unauthenticated local gateways.
      // The proxy simply won't inject a token in that case.

      let upstreamOrigin = ''
      try {
        upstreamOrigin = resolveOriginForUpstream(upstreamUrl)
      } catch {
        closeBoth(1011, 'clawboo.gateway_url_invalid')
        return
      }

      if (closed) return

      // ── Open upstream connection ─────────────────────────────────────────
      const upstream = new WebSocket(upstreamUrl, { origin: upstreamOrigin })
      upstreamWs = upstream

      upstream.on('open', () => {
        upstreamReady = true
        log('proxy upstream connected', { upstreamUrl })

        // Flush any browser messages that arrived while we were connecting
        for (const msg of pendingBrowserMessages) {
          const p = safeJsonParse(msg)
          if (p) forwardToUpstream(msg, p)
        }
        pendingBrowserMessages.length = 0

        // Flush any upstream messages buffered before browser WS was open
        for (const msg of pendingUpstreamMessages) {
          sendToBrowser(msg)
        }
        pendingUpstreamMessages.length = 0

        // Application-level keepalive: ping the upstream each interval; if no pong
        // arrived since the last ping, the TCP connection is half-open — terminate
        // it so the close path runs immediately instead of stalling on a 60s+ RPC
        // timeout. (OS TCP keepalive is too slow / not guaranteed.)
        upstream.on('pong', () => {
          awaitingPong = false
        })
        keepaliveTimer = setInterval(() => {
          if (closed) {
            stopKeepalive()
            return
          }
          if (awaitingPong) {
            logError('proxy: upstream keepalive timed out — terminating half-open connection')
            try {
              upstream.terminate()
            } catch {
              /* already gone */
            }
            stopKeepalive()
            return
          }
          awaitingPong = true
          try {
            upstream.ping()
          } catch {
            /* gone — the close path will fire */
          }
        }, keepaliveIntervalMs)
        keepaliveTimer.unref?.()
      })

      // ── Upstream → browser ─────────────────────────────────────────────
      upstream.on('message', (upRaw: Buffer | string) => {
        const upStr = String(upRaw ?? '')
        const upParsed = safeJsonParse(upStr)

        // Track when the connect response is delivered
        if (upParsed?.['type'] === 'res') {
          const resId = typeof upParsed['id'] === 'string' ? upParsed['id'] : ''
          if (resId && connectRequestId && resId === connectRequestId) {
            connectResponseSent = true
          }
        }

        // Capture nonce from connect.challenge events for device auth signing
        if (upParsed?.['type'] === 'event' && upParsed['event'] === 'connect.challenge') {
          const payload = upParsed['payload'] as Record<string, unknown> | undefined
          const nonce = typeof payload?.['nonce'] === 'string' ? payload['nonce'] : null
          if (nonce) {
            connectNonce = nonce
            log('proxy: captured connect.challenge nonce')
          }
        }

        // Forward to browser (buffer if browser hasn't fully opened yet)
        if (browserWs.readyState === WebSocket.OPEN) {
          sendToBrowser(upStr)
        } else {
          bufferOrOverflow(pendingUpstreamMessages, upStr)
        }
      })

      upstream.on('close', (code: number, reason: Buffer) => {
        const reasonStr = reason.toString()
        log('upstream closed', { code, reason: reasonStr })
        if (!connectResponseSent && connectRequestId) {
          sendToBrowser(
            buildErrorResponse(
              connectRequestId,
              'clawboo.upstream_closed',
              `Upstream gateway closed (${code}): ${reasonStr}`,
            ),
          )
        }
        closeBoth(1012, 'upstream closed')
      })

      upstream.on('error', (err: Error) => {
        logError('Upstream gateway WebSocket error.', err)
        if (connectRequestId && !connectResponseSent) {
          sendToBrowser(
            buildErrorResponse(
              connectRequestId,
              'clawboo.upstream_error',
              'Failed to connect to upstream gateway WebSocket.',
            ),
          )
          connectResponseSent = true
        }
        closeBoth(1011, 'upstream error')
      })
    })()

    // ── Browser → proxy ──────────────────────────────────────────────────────

    browserWs.on('message', (rawData: Buffer | string) => {
      const raw = String(rawData ?? '')
      const parsed = safeJsonParse(raw)
      if (!parsed) {
        closeBoth(1003, 'invalid json')
        return
      }

      // Track the connect request id for error correlation
      if (!connectRequestId && parsed['type'] === 'req' && parsed['method'] === 'connect') {
        const id = typeof parsed['id'] === 'string' ? parsed['id'] : ''
        if (id) connectRequestId = id
      }

      // If upstream isn't ready yet, buffer the message (bounded)
      if (!upstreamReady || !upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) {
        bufferOrOverflow(pendingBrowserMessages, raw)
        return
      }

      forwardToUpstream(raw, parsed)
    })

    browserWs.on('close', () => {
      log('browser closed')
      closeBoth(1000, 'client closed')
    })

    browserWs.on('error', (err: Error) => {
      logError('Browser WebSocket error.', err)
      closeBoth(1011, 'client error')
    })
  })

  // ── Upgrade handler ──────────────────────────────────────────────────────

  const handleUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => {
    if (!allowWs(req)) {
      socket.destroy()
      return
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      wss.emit('connection', ws, req)
    })
  }

  return { wss, handleUpgrade }
}
