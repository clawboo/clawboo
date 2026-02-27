import type { IncomingMessage } from 'node:http'
import type { Duplex } from 'node:stream'
import { URL } from 'node:url'

import { WebSocket, WebSocketServer } from 'ws'

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
}

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
function hasDeviceSignature(params: unknown): boolean {
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
 * This is a fallback for when the browser didn't include a token (e.g.
 * unauthenticated local gateways). The primary path is for the browser
 * to include its own auth.token (obtained from /api/settings) so that
 * device identity signing can include the correct token in its payload.
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
  } = options

  const wss = new WebSocketServer({ noServer: true })

  wss.on('connection', (browserWs: WebSocket) => {
    let upstreamWs: WebSocket | null = null
    let upstreamReady = false
    let upstreamToken = ''
    let connectRequestId: string | null = null
    let connectResponseSent = false
    let closed = false
    // Buffer for browser messages that arrive before upstream is ready
    const pendingBrowserMessages: string[] = []
    // Buffer for upstream messages that arrive before browser WS is open
    const pendingUpstreamMessages: string[] = []

    // ── Lifecycle ────────────────────────────────────────────────────────────

    const closeBoth = (code: number, reason: string): void => {
      if (closed) return
      closed = true
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

    const sendToBrowser = (data: string): void => {
      if (browserWs.readyState !== WebSocket.OPEN) return
      browserWs.send(data)
    }

    // ── Forward browser message to upstream ──────────────────────────────────

    const forwardToUpstream = (raw: string, parsed: Record<string, unknown>): void => {
      if (!upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) return

      // On connect frames: inject the server-side auth token if the browser
      // didn't include one. The browser may send device identity (Ed25519
      // signature) which is preserved as-is — device identity and auth token
      // are independent; the gateway requires both.
      if (parsed['type'] === 'req' && parsed['method'] === 'connect') {
        const params = parsed['params']
        const browserHasToken = hasNonEmptyToken(params)
        if (browserHasToken) {
          log('proxy: forwarding connect frame as-is (browser has auth token)', {
            hasDevice: hasDeviceSignature(params),
          })
          upstreamWs.send(JSON.stringify(parsed))
        } else {
          log('proxy: injecting server-side auth token', {
            hasDevice: hasDeviceSignature(params),
            hasToken: upstreamToken.length > 0,
          })
          upstreamWs.send(
            JSON.stringify({
              ...parsed,
              params: injectAuthToken(parsed['params'], upstreamToken),
            }),
          )
        }
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

        // Forward to browser (buffer if browser hasn't fully opened yet)
        if (browserWs.readyState === WebSocket.OPEN) {
          sendToBrowser(upStr)
        } else {
          pendingUpstreamMessages.push(upStr)
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

      // If upstream isn't ready yet, buffer the message
      if (!upstreamReady || !upstreamWs || upstreamWs.readyState !== WebSocket.OPEN) {
        pendingBrowserMessages.push(raw)
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
