import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AccessGateOptions {
  /** Value of the STUDIO_ACCESS_TOKEN env var (blank/undefined = gate disabled). */
  token?: string
  /** Cookie name to set. Defaults to 'clawboo_access'. */
  cookieName?: string
  /** URL query param that carries the one-time token. Defaults to 'access_token'. */
  queryParam?: string
}

export interface AccessGate {
  /** True when a non-empty token was provided and the gate is active. */
  enabled: boolean
  /**
   * Call at the top of every HTTP request handler.
   * Returns true when the response has been handled (caller must not write again).
   * - Validates ?access_token=... query param, sets HttpOnly cookie, redirects.
   * - Blocks /api/* requests that lack a valid cookie.
   */
  handleHttp: (req: IncomingMessage, res: ServerResponse) => boolean
  /**
   * Returns true when a WebSocket upgrade request should be allowed.
   * Always true when gate is disabled.
   */
  allowUpgrade: (req: IncomingMessage) => boolean
}

// ─── Cookie parser ──────────────────────────────────────────────────────────

function parseCookies(header: string | undefined): Record<string, string> {
  const raw = typeof header === 'string' ? header : ''
  if (!raw.trim()) return {}
  const out: Record<string, string> = {}
  for (const part of raw.split(';')) {
    const idx = part.indexOf('=')
    if (idx === -1) continue
    const key = part.slice(0, idx).trim()
    const value = part.slice(idx + 1).trim()
    if (!key) continue
    out[key] = value
  }
  return out
}

// ─── Redirect URL builder ───────────────────────────────────────────────────

function buildRedirectUrl(req: IncomingMessage, nextPathWithQuery: string): string {
  const host = req.headers.host || 'localhost'
  const proto = requestIsHttps(req) ? 'https' : 'http'
  return `${proto}://${host}${nextPathWithQuery}`
}

// ─── Constant-time token compare ──────────────────────────────────────────────

/**
 * Compare two secret strings in constant time. Both inputs are SHA-256-hashed to
 * a fixed 32-byte digest first, so the comparison neither short-circuits on the
 * first differing byte (timing oracle) nor leaks the token length.
 */
function constantTimeEquals(a: string, b: string): boolean {
  const ah = createHash('sha256').update(a).digest()
  const bh = createHash('sha256').update(b).digest()
  return timingSafeEqual(ah, bh)
}

/** True when the request reached us over TLS (directly or via a terminating proxy). */
function requestIsHttps(req: IncomingMessage): boolean {
  return String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https'
}

/** True when the TCP peer is loopback — the only origin a server's own spawned
 *  runtimes connect from. A remote client cannot forge a loopback source on a real
 *  TCP handshake, so this is a safe basis for the /api/mcp/* control-plane exemption. */
function isLoopbackRequest(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

// ─── createAccessGate ───────────────────────────────────────────────────────

/** Header-safe token charset: cookie-value safe + identical between the cookie read
 *  and the percent-decoded query-param read (no '%'/'+'/';'/',' / whitespace). */
const SAFE_TOKEN_RE = /^[A-Za-z0-9._~-]+$/

export function createAccessGate(options: AccessGateOptions = {}): AccessGate {
  let token = String(options.token ?? '').trim()
  const cookieName = String(options.cookieName ?? 'clawboo_access').trim() || 'clawboo_access'
  const queryParam = String(options.queryParam ?? 'access_token').trim() || 'access_token'
  // The gate is the ONLY auth for a non-loopback bind, and the token is written raw
  // into the Set-Cookie value + compared raw against the cookie but percent-decoded in
  // the query path. A token with a cookie-delimiter / non-token char would corrupt the
  // cookie and silently lock the operator out of every /api/* route (a permanent 401
  // with no hint). Fail LOUD and DISABLE the gate rather than ship that lockout.
  if (token && !SAFE_TOKEN_RE.test(token)) {
    const bad = [...token].find((c) => !SAFE_TOKEN_RE.test(c))
    console.warn(
      `[clawboo] STUDIO_ACCESS_TOKEN contains an unsupported character (${JSON.stringify(bad)}); ` +
        'the access gate is DISABLED. Use only [A-Za-z0-9._~-].',
    )
    token = ''
  }
  const enabled = Boolean(token)

  function isAuthorized(req: IncomingMessage): boolean {
    if (!enabled) return true
    const cookies = parseCookies(req.headers.cookie)
    return constantTimeEquals(cookies[cookieName] ?? '', token)
  }

  function handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    if (!enabled) return false

    const host = req.headers.host || 'localhost'
    const url = new URL(req.url ?? '/', `http://${host}`)
    const provided = url.searchParams.get(queryParam)

    // ── Token provided in query string ──────────────────────────────────────
    if (provided !== null) {
      if (!constantTimeEquals(provided, token)) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Invalid Clawboo access token.' }))
        return true
      }

      // Valid token — set HttpOnly cookie and redirect to strip the token from the URL.
      // `Secure` only when the request arrived over TLS: a Secure cookie is never sent
      // back over plain http, so adding it unconditionally would break the gate on a
      // loopback/dev http origin.
      url.searchParams.delete(queryParam)
      const secure = requestIsHttps(req) ? '; Secure' : ''
      res.statusCode = 302
      res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; Path=/; SameSite=Lax${secure}`)
      res.setHeader('Location', buildRedirectUrl(req, url.pathname + url.search))
      res.end()
      return true
    }

    // ── API routes require a valid cookie ───────────────────────────────────
    // Lower-case the pathname before the prefix test as defense-in-depth: the gate
    // package can't assume the host app enabled case-sensitive routing, so it folds
    // case itself — an uppercased `/API/settings` must never evade the gate and reach
    // a sensitive route unauthenticated.
    if (url.pathname.toLowerCase().startsWith('/api/')) {
      // Loopback exemption for the spawned-runtime control plane: a runtime attaches
      // its MCP client to http://127.0.0.1:<port>/api/mcp/* with no cookie (its env is
      // scrubbed of the token by design). A loopback /api/mcp/* request is the server's
      // own runtime — let it through. Every other /api/* route, and any NON-loopback
      // /api/mcp/* request, still requires the cookie.
      if (url.pathname.toLowerCase().startsWith('/api/mcp/') && isLoopbackRequest(req)) {
        return false
      }
      if (!isAuthorized(req)) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json')
        res.end(
          JSON.stringify({
            error:
              'Clawboo access token required. Open /?access_token=<token> once to set a cookie.',
          }),
        )
        return true
      }
    }

    return false
  }

  function allowUpgrade(req: IncomingMessage): boolean {
    if (!enabled) return true
    return isAuthorized(req)
  }

  return { enabled, handleHttp, allowUpgrade }
}
