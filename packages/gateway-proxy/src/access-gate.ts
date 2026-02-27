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
  const proto =
    String(req.headers['x-forwarded-proto'] ?? '').toLowerCase() === 'https' ? 'https' : 'http'
  return `${proto}://${host}${nextPathWithQuery}`
}

// ─── createAccessGate ───────────────────────────────────────────────────────

export function createAccessGate(options: AccessGateOptions = {}): AccessGate {
  const token = String(options.token ?? '').trim()
  const cookieName = String(options.cookieName ?? 'clawboo_access').trim() || 'clawboo_access'
  const queryParam = String(options.queryParam ?? 'access_token').trim() || 'access_token'
  const enabled = Boolean(token)

  function isAuthorized(req: IncomingMessage): boolean {
    if (!enabled) return true
    const cookies = parseCookies(req.headers.cookie)
    return cookies[cookieName] === token
  }

  function handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    if (!enabled) return false

    const host = req.headers.host || 'localhost'
    const url = new URL(req.url ?? '/', `http://${host}`)
    const provided = url.searchParams.get(queryParam)

    // ── Token provided in query string ──────────────────────────────────────
    if (provided !== null) {
      if (provided !== token) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json')
        res.end(JSON.stringify({ error: 'Invalid Clawboo access token.' }))
        return true
      }

      // Valid token — set HttpOnly cookie and redirect to strip the token from the URL
      url.searchParams.delete(queryParam)
      res.statusCode = 302
      res.setHeader('Set-Cookie', `${cookieName}=${token}; HttpOnly; Path=/; SameSite=Lax`)
      res.setHeader('Location', buildRedirectUrl(req, url.pathname + url.search))
      res.end()
      return true
    }

    // ── API routes require a valid cookie ───────────────────────────────────
    if (url.pathname.startsWith('/api/')) {
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
