import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'

// ─── Types ─────────────────────────────────────────────────────────────────

export interface AccessGateOptions {
  /**
   * Value of the STUDIO_ACCESS_TOKEN env var (blank/undefined = gate disabled).
   * A token with a character outside `ACCESS_TOKEN_CHARSET` throws.
   */
  token?: string
  /** Cookie name to set. Defaults to 'clawboo_access'. */
  cookieName?: string
  /** URL query param that carries the one-time token. Defaults to 'access_token'. */
  queryParam?: string
  /**
   * The URL prefix the app is mounted under ('' = origin root), already normalized.
   *
   * The gate runs BEHIND the base-path strip, so the pathnames it tests are always
   * root-form and its `/api/` checks need no change. This is used only where a
   * path leaves the gate: the cookie's `Path` (so a mount does not hand its
   * operator cookie to a sibling app on the same origin) and the post-exchange
   * redirect (which must land back under the mount, not at the origin root).
   */
  basePath?: string
  /**
   * Admits a cookieless `/api/mcp/*` request from one of the server's own spawned
   * runtimes: return true when it carries the credential the server minted into
   * that runtime's attach URL. Consulted only for `/api/mcp/*`, only when the
   * cookie is missing or wrong, and only for a request that dialed the loopback
   * port directly: never one from another host, and never one a proxy forwarded.
   * Omitted ⇒ `/api/mcp/*` needs the cookie like every other route.
   */
  authorizeRuntime?: (req: IncomingMessage) => boolean
}

export interface AccessGate {
  /** True when a non-empty token was provided and the gate is active. */
  enabled: boolean
  /**
   * Call at the top of every HTTP request handler.
   * Returns true when the response has been handled (caller must not write again).
   * - Validates ?access_token=... query param, sets HttpOnly cookie, redirects.
   * - Blocks /api/* requests that lack a valid cookie, except an /api/mcp/*
   *   request that `authorizeRuntime` vouches for.
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

/**
 * True when the TCP peer is loopback.
 *
 * NECESSARY for the runtime exemption, never sufficient. A spawned runtime always
 * dials the loopback port, so requiring it keeps an attach token that leaked off
 * the box useless from anywhere else. It cannot admit anything on its own: a
 * same-host reverse proxy delivers every remote request from loopback too, which
 * is exactly how the old exemption, keyed on this alone, was bypassed.
 */
function isLoopbackPeer(req: IncomingMessage): boolean {
  const addr = req.socket?.remoteAddress ?? ''
  return addr === '127.0.0.1' || addr === '::1' || addr === '::ffff:127.0.0.1'
}

/** Headers a reverse proxy adds on the way in. A spawned runtime dials the
 *  server's loopback port directly and never sends one. */
const FORWARDING_HEADERS = [
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
] as const

/**
 * True when a reverse proxy carried the request here.
 *
 * Never a basis for GRANTING access: a direct caller can send these headers or
 * leave them out. It only ever takes access away, so that a runtime's attach
 * token replayed through the operator's proxy is still refused. Exported so the
 * server's proxy-exposure warning keys off the same header list.
 */
export function isForwardedRequest(req: IncomingMessage): boolean {
  return FORWARDING_HEADERS.some((name) => req.headers[name] !== undefined)
}

// ─── createAccessGate ───────────────────────────────────────────────────────

/** Header-safe token charset: cookie-value safe + identical between the cookie read
 *  and the percent-decoded query-param read (no '%'/'+'/';'/',' / whitespace). */
export const ACCESS_TOKEN_CHARSET = 'A-Za-z0-9._~-'
const SAFE_TOKEN_RE = /^[A-Za-z0-9._~-]+$/

/**
 * The first character of `token` the gate cannot use, or null when the token is
 * usable. A blank or unset token is null too: no token means no gate, which is a
 * choice, not an error. Trims first, exactly as `createAccessGate` does.
 */
export function findUnsupportedTokenChar(token: string | undefined): string | null {
  const trimmed = String(token ?? '').trim()
  if (!trimmed || SAFE_TOKEN_RE.test(trimmed)) return null
  return [...trimmed].find((c) => !SAFE_TOKEN_RE.test(c)) ?? null
}

export function createAccessGate(options: AccessGateOptions = {}): AccessGate {
  const token = String(options.token ?? '').trim()
  const cookieName = String(options.cookieName ?? 'clawboo_access').trim() || 'clawboo_access'
  const queryParam = String(options.queryParam ?? 'access_token').trim() || 'access_token'
  // '' at the origin root, else '/mount'. The cookie needs a non-empty Path.
  const basePath = String(options.basePath ?? '').trim()
  const cookiePath = basePath || '/'
  const authorizeRuntime = options.authorizeRuntime
  // The token is written raw into the Set-Cookie value and compared raw against the
  // cookie, but percent-decoded on the query path. A token with a cookie delimiter
  // or other non-token character would corrupt the cookie and lock the operator out
  // of every /api/* route. Dropping the gate instead would serve those routes with
  // no auth at all, which a loopback bind behind a same-host reverse proxy does not
  // catch. So an unusable token is an error: the operator asked for a gate, and
  // gets one or nothing starts. The server checks first and exits with a SECURITY
  // message; this throw is the backstop for any other caller.
  const unsupported = findUnsupportedTokenChar(token)
  if (unsupported !== null) {
    throw new Error(
      `STUDIO_ACCESS_TOKEN contains an unsupported character (${JSON.stringify(unsupported)}); ` +
        `use only [${ACCESS_TOKEN_CHARSET}].`,
    )
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
      res.setHeader(
        'Set-Cookie',
        `${cookieName}=${token}; HttpOnly; Path=${cookiePath}; SameSite=Lax${secure}`,
      )
      // The pathname here is post-strip, so re-attach the mount prefix or the
      // operator is redirected to the origin root and out of the app.
      res.setHeader('Location', buildRedirectUrl(req, basePath + url.pathname + url.search))
      res.end()
      return true
    }

    // ── API routes require a valid cookie ───────────────────────────────────
    // Lower-case the pathname before the prefix test as defense-in-depth: the gate
    // package can't assume the host app enabled case-sensitive routing, so it folds
    // case itself — an uppercased `/API/settings` must never evade the gate and reach
    // a sensitive route unauthenticated.
    if (url.pathname.toLowerCase().startsWith('/api/')) {
      // The spawned-runtime control plane. A runtime attaches its MCP client to
      // http://127.0.0.1:<port>/api/mcp/* with no cookie (its env is scrubbed of the
      // token by design), so it proves itself with the attach token the server
      // minted into its URL instead, which `authorizeRuntime` checks.
      //
      // NOT by its source address. That was the old rule (a loopback peer is our
      // own runtime), and a same-host reverse proxy breaks it: nginx, Caddy or a
      // tunnel connector delivers every remote request from 127.0.0.1, which put
      // the whole control plane on the internet, /api/mcp/config included, and
      // that route mints signed agent identities. The address and the forwarding
      // headers now only ever take access away: a runtime dials loopback directly,
      // so a token arriving any other way is refused.
      if (
        url.pathname.toLowerCase().startsWith('/api/mcp/') &&
        isLoopbackPeer(req) &&
        !isForwardedRequest(req) &&
        authorizeRuntime?.(req) === true
      ) {
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
