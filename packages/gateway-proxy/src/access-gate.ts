import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'

import { ACCESS_TOKEN_CHARSET, findUnsupportedTokenChar } from '@clawboo/config'

import { anyPathUnder, everyPathUnder } from './request-path'

// The token charset lives with the token resolver in @clawboo/config, so the
// file the server and the desktop app share and the gate agree on one rule.
// Re-exported by name for the gate's existing importers.
export { ACCESS_TOKEN_CHARSET, findUnsupportedTokenChar }

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
  /** URL query param that carries a one-time launch code. Defaults to 'access_code'. */
  codeParam?: string
  /** How long a launch code stays valid. Defaults to 120 000 ms. */
  launchCodeTtlMs?: number
  /** Clock for launch-code expiry. Defaults to `Date.now`. */
  now?: () => number
  /**
   * The URL prefix the app is mounted under ('' = origin root), already normalized.
   *
   * The gate runs BEHIND the base-path strip, so the paths it tests are always
   * root-form and its `/api/` checks need no change. This is used only where a
   * path leaves the gate: the cookie's `Path` (so a mount does not hand its
   * operator cookie to a sibling app on the same origin) and the post-exchange
   * redirect (which must land back under the mount, not at the origin root).
   */
  basePath?: string
  /**
   * Admits a cookieless `/api/mcp/*` request from one of the server's own spawned
   * runtimes: return true when it carries the credential the server minted into
   * that runtime's attach URL. Consulted only for a path that is `/api/mcp/*`
   * however it is read (see request-path.ts), only when the cookie is missing or
   * wrong, and only for a request that dialed the loopback port directly: never
   * one from another host, and never one a proxy forwarded.
   * Omitted ⇒ `/api/mcp/*` needs the cookie like every other route.
   */
  authorizeRuntime?: (req: IncomingMessage) => boolean
}

/** A one-time code that trades for the access cookie. */
export interface LaunchCode {
  code: string
  /** Epoch ms after which the code is refused, on the server's clock. */
  expiresAt: number
  /** The code's lifetime from now, for a client whose clock may differ. */
  expiresInMs: number
}

export interface AccessGate {
  /** True when a non-empty token was provided and the gate is active. */
  enabled: boolean
  /**
   * Call at the top of every HTTP request handler.
   * Returns true when the response has been handled (caller must not write again).
   * - Validates ?access_token=... query param, sets HttpOnly cookie, redirects.
   * - Trades a ?access_code=... launch code for the same cookie, once, on a
   *   non-API path, and redirects without it whether or not the code was good.
   * - Blocks /api/* requests that lack a valid cookie, except an /api/mcp/*
   *   request that `authorizeRuntime` vouches for.
   */
  handleHttp: (req: IncomingMessage, res: ServerResponse) => boolean
  /**
   * Mint a launch code: single use, held in memory only, valid for
   * `launchCodeTtlMs`. Null when the gate is off. The caller must already hold
   * the cookie (the minting route sits behind this gate).
   */
  mintLaunchCode: () => LaunchCode | null
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

/**
 * True when a browser is loading this URL as a page: a top-level navigation, by
 * the fetch metadata every current browser sends. A link previewer (a chat app
 * fetching a pasted link to draw a card), a script or a frame sends something
 * else or nothing, and must not spend a launch code: the code would buy it the
 * token, and the device the link was meant for would be locked out.
 */
function isPageLoad(req: IncomingMessage): boolean {
  return (
    String(req.headers['sec-fetch-mode'] ?? '').toLowerCase() === 'navigate' &&
    String(req.headers['sec-fetch-dest'] ?? '').toLowerCase() === 'document'
  )
}

/**
 * True when the request carries any fetch metadata. Browsers send it only to an
 * HTTPS or loopback origin, so a phone on a plain-HTTP LAN address sends none,
 * and neither do link previewers, scripts and older browsers.
 */
function hasFetchMetadata(req: IncomingMessage): boolean {
  return ['sec-fetch-mode', 'sec-fetch-dest', 'sec-fetch-site'].some(
    (name) => req.headers[name] !== undefined,
  )
}

/**
 * True when this POST is the sign-in page's own form being submitted: a
 * form-encoded body, fetch metadata (when the browser sends any) of a
 * same-origin page navigation, and an Origin (when sent) of this very origin.
 * A fetch(), a frame, another site's form or a script's POST is none of these,
 * so it cannot spend a code even if it holds one.
 */
function isSignInFormPost(req: IncomingMessage): boolean {
  const type = String(req.headers['content-type'] ?? '').toLowerCase()
  if (!type.startsWith('application/x-www-form-urlencoded')) return false
  if (hasFetchMetadata(req)) {
    const header = (name: string): string => String(req.headers[name] ?? '').toLowerCase()
    if (header('sec-fetch-mode') !== 'navigate' || header('sec-fetch-dest') !== 'document') {
      return false
    }
    const site = header('sec-fetch-site')
    if (site !== '' && site !== 'same-origin') return false
  }
  const origin = req.headers.origin
  if (origin === undefined) return true
  const own = `${requestIsHttps(req) ? 'https' : 'http'}://${req.headers.host ?? ''}`
  return String(origin).toLowerCase() === own.toLowerCase()
}

/** The only shape a minted launch code has, so nothing else is ever echoed into a page. */
const LAUNCH_CODE_SHAPE = /^[A-Za-z0-9_-]{16,256}$/

/**
 * The page a request with no fetch metadata gets for a launch code: one button
 * that POSTs the code back. A browser's person taps it; a link previewer never
 * submits a form, so it never spends the code (or receives the token).
 */
function launchCodeConfirmPage(code: string): string {
  return (
    '<!doctype html><html lang="en"><head><meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<title>Sign in to Clawboo</title><style>' +
    'body{font-family:system-ui,sans-serif;display:flex;min-height:100vh;margin:0;' +
    'align-items:center;justify-content:center;background:#f6f6f7;color:#111}' +
    'main{max-width:22rem;padding:1.5rem;text-align:center}' +
    'button{font:inherit;font-weight:600;padding:.7rem 1.4rem;border:0;border-radius:.6rem;' +
    'background:#e94560;color:#fff;cursor:pointer}p{color:#555;font-size:.9rem}' +
    '</style></head><body><main><h1>Sign in to Clawboo</h1>' +
    '<p>This one-time link signs in this browser. It works once, within two minutes.</p>' +
    `<form method="post" action="?access_code=${code}">` +
    '<button type="submit">Sign in</button></form></main></body></html>'
  )
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

/**
 * True when this is one of the server's own spawned runtimes calling its
 * control plane: every reading of its path under `/api/mcp/` (see
 * request-path.ts), dialed on the loopback port directly (never forwarded by a
 * proxy), carrying the attach token `authorizeRuntime` vouches for. The access
 * gate admits these without the cookie, and the server's proxy identity lane
 * without a person's token, by this one test.
 */
export function isRuntimeControlRequest(
  req: IncomingMessage,
  authorizeRuntime: ((req: IncomingMessage) => boolean) | undefined,
): boolean {
  return (
    everyPathUnder(req, '/api/mcp/') &&
    isLoopbackPeer(req) &&
    !isForwardedRequest(req) &&
    authorizeRuntime?.(req) === true
  )
}

// ─── createAccessGate ───────────────────────────────────────────────────────

/** At most this many unused launch codes are held; minting another drops the oldest. */
const MAX_LAUNCH_CODES = 64
const DEFAULT_LAUNCH_CODE_TTL_MS = 120_000

/** Stored by digest, so a lookup never compares the secret itself byte by byte. */
function digest(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

/** Parses a path-only target. Only the path and query are ever read from it, so
 *  the request's Host header plays no part (a bad one cannot break parsing). */
const PARSE_BASE = 'http://clawboo.invalid'

/** The body of every 401 for a missing or wrong cookie. Older launchers and the
 *  desktop app recognise the gate by "clawboo" and "token" in `error`; the
 *  dashboard reads `gate`. */
const ACCESS_REQUIRED_BODY = JSON.stringify({
  error:
    'Clawboo access token required. Run `clawboo open` on the computer running Clawboo, ' +
    'or open /?access_token=<token> once to set a cookie.',
  gate: 'clawboo-access',
})

export function createAccessGate(options: AccessGateOptions = {}): AccessGate {
  const token = String(options.token ?? '').trim()
  const cookieName = String(options.cookieName ?? 'clawboo_access').trim() || 'clawboo_access'
  const queryParam = String(options.queryParam ?? 'access_token').trim() || 'access_token'
  const codeParam = String(options.codeParam ?? 'access_code').trim() || 'access_code'
  const launchCodeTtlMs = options.launchCodeTtlMs ?? DEFAULT_LAUNCH_CODE_TTL_MS
  const now = options.now ?? Date.now
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

  // Unused launch codes, digest -> expiry, oldest first (Map keeps insertion order).
  const launchCodes = new Map<string, number>()

  function dropExpiredCodes(): void {
    const at = now()
    for (const [key, expiresAt] of launchCodes) {
      if (expiresAt <= at) launchCodes.delete(key)
    }
  }

  function mintLaunchCode(): LaunchCode | null {
    if (!enabled) return null
    dropExpiredCodes()
    while (launchCodes.size >= MAX_LAUNCH_CODES) {
      const oldest = launchCodes.keys().next().value
      if (oldest === undefined) break
      launchCodes.delete(oldest)
    }
    const code = randomBytes(24).toString('base64url')
    const expiresAt = now() + launchCodeTtlMs
    launchCodes.set(digest(code), expiresAt)
    return { code, expiresAt, expiresInMs: launchCodeTtlMs }
  }

  /** True once per minted code, within its lifetime. */
  function redeemLaunchCode(offered: string): boolean {
    const key = digest(offered)
    const expiresAt = launchCodes.get(key)
    if (expiresAt === undefined) return false
    launchCodes.delete(key)
    return now() < expiresAt
  }

  /** The Set-Cookie value that signs this browser in. `Secure` only over TLS: a
   *  Secure cookie is never sent back over plain http, so adding it always would
   *  break the gate on a loopback/dev http origin. */
  function accessCookie(req: IncomingMessage): string {
    const secure = requestIsHttps(req) ? '; Secure' : ''
    return `${cookieName}=${token}; HttpOnly; Path=${cookiePath}; SameSite=Lax${secure}`
  }

  function isAuthorized(req: IncomingMessage): boolean {
    if (!enabled) return true
    const cookies = parseCookies(req.headers.cookie)
    return constantTimeEquals(cookies[cookieName] ?? '', token)
  }

  function handleHttp(req: IncomingMessage, res: ServerResponse): boolean {
    if (!enabled) return false

    let url: URL
    try {
      url = new URL(req.url ?? '/', PARSE_BASE)
    } catch {
      // A target the URL parser cannot read is not a request any client sends,
      // and its path cannot be read every way the router might. Refused.
      res.statusCode = 400
      res.setHeader('Content-Type', 'application/json')
      res.end(JSON.stringify({ error: 'Bad request target.' }))
      return true
    }
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
      url.searchParams.delete(queryParam)
      res.statusCode = 302
      res.setHeader('Set-Cookie', accessCookie(req))
      // The pathname here is post-strip, so re-attach the mount prefix or the
      // operator is redirected to the origin root and out of the app.
      res.setHeader('Location', buildRedirectUrl(req, basePath + url.pathname + url.search))
      res.end()
      return true
    }

    // An API path is one whose path is under `/api/` however it is read: as sent,
    // as the URL parser resolves it, or as the router matches it (see
    // request-path.ts). They differ for dot segments and backslashes, and the
    // router acts on its own reading, so the gate cannot pick just one. Letter
    // case is folded too, as defense-in-depth: the gate package can't assume the
    // host app enabled case-sensitive routing, so an uppercased `/API/settings`
    // must never evade the gate and reach a sensitive route unauthenticated.
    const isApiPath = anyPathUnder(req, '/api/')

    // ── Launch code in a page URL ───────────────────────────────────────────
    // `clawboo open` and the dashboard's "Open on another device" hand a browser
    // a code instead of the token: an opener's arguments are visible to other
    // local users, and a URL lands in history, but a code is spent on first use
    // and dead within minutes. Never on an /api/ path, where it would let a
    // script holding a code skip the cookie; there it is ignored, and not spent.
    // A code is spent by a page load (see isPageLoad), or by the POST from the
    // sign-in page below (see isSignInFormPost). A request with no fetch metadata at all (a phone on a
    // plain-HTTP LAN address, an older browser, a link previewer) gets that page
    // instead of being spent. Anything else (a fetch, a frame) is redirected
    // without the cookie and leaves the code for the browser. A spent, expired
    // or unknown code still redirects, without the cookie, so the browser lands
    // on the dashboard's locked screen, which says how to get in.
    const offeredCode = isApiPath ? null : url.searchParams.get(codeParam)
    if (offeredCode !== null) {
      const posted = String(req.method ?? 'GET').toUpperCase() === 'POST'
      if (!posted && !hasFetchMetadata(req) && LAUNCH_CODE_SHAPE.test(offeredCode)) {
        res.statusCode = 200
        res.setHeader('Content-Type', 'text/html; charset=utf-8')
        res.setHeader('Cache-Control', 'no-store')
        // Not no-referrer: under it a browser sends `Origin: null` on the form's
        // POST, which isSignInFormPost refuses. The page links nowhere else.
        res.setHeader('Referrer-Policy', 'same-origin')
        res.setHeader(
          'Content-Security-Policy',
          "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'",
        )
        res.end(launchCodeConfirmPage(offeredCode))
        return true
      }
      url.searchParams.delete(codeParam)
      // 303 after the POST, so the browser follows with a GET.
      res.statusCode = posted ? 303 : 302
      const spends = posted ? isSignInFormPost(req) : isPageLoad(req)
      if (spends && redeemLaunchCode(offeredCode)) {
        res.setHeader('Set-Cookie', accessCookie(req))
      }
      res.setHeader('Location', buildRedirectUrl(req, basePath + url.pathname + url.search))
      res.end()
      return true
    }

    // ── API routes require a valid cookie ───────────────────────────────────
    if (isApiPath) {
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
      // so a token arriving any other way is refused. Every reading of the path
      // must be under `/api/mcp/`: one that only resolves there may be routed
      // elsewhere (see isRuntimeControlRequest).
      if (isRuntimeControlRequest(req, authorizeRuntime)) return false
      if (!isAuthorized(req)) {
        res.statusCode = 401
        res.setHeader('Content-Type', 'application/json')
        res.end(ACCESS_REQUIRED_BODY)
        return true
      }
    }

    return false
  }

  function allowUpgrade(req: IncomingMessage): boolean {
    if (!enabled) return true
    return isAuthorized(req)
  }

  return { enabled, handleHttp, allowUpgrade, mintLaunchCode }
}
