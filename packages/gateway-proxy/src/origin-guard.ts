import type { IncomingMessage, ServerResponse } from 'node:http'
import { URL } from 'node:url'

// ─── Origin/Host guard — CSWSH + DNS-rebinding + cross-site CSRF defense ───────
//
// The dashboard's WS proxy (`/api/gateway/ws`) injects the upstream Gateway bearer
// token server-side, so a hijacked socket rides authenticated upstream access with
// no secret from the page. Browsers auto-send cookies AND automatically set the
// `Origin` header on cross-site WebSocket handshakes / state-changing fetches (JS
// cannot forge or omit it) — so validating `Origin` is the canonical CSWSH defense,
// and a `Host` allowlist is the canonical DNS-rebinding defense. This guard runs
// ALWAYS, independent of the STUDIO_ACCESS_TOKEN gate (`access-gate.ts`): the token
// gate is opt-in and off by default, but CSWSH must be closed on a default install.
//
// Posture: the loopback allowlist is ALWAYS enforced (the default `npx clawboo`
// bind is fully protected with zero config). The env allowlists (CLAWBOO_ALLOWED_*)
// only WIDEN the set — they never disable enforcement — so a `HOST=0.0.0.0` bind,
// which still serves 127.0.0.1, cannot silently re-open the hole. A non-loopback /
// LAN bind must enumerate its reachable origins via CLAWBOO_ALLOWED_ORIGINS.

// ─── Types ─────────────────────────────────────────────────────────────────

export interface OriginGuardOptions {
  /** The resolved API port the server bound to. */
  port: number
  /** The host the server bound to (from resolveHost); default '127.0.0.1'. */
  bindHost?: string
  /** Dev mode: additionally trust the Vite dev-server origin. */
  dev?: boolean
  /** Vite dev-server port (default 5173). */
  devPort?: number
  /** Extra exact origins to trust (from CLAWBOO_ALLOWED_ORIGINS). */
  allowedOrigins?: string[]
  /** Extra hostnames to trust for the Host header (from CLAWBOO_ALLOWED_HOSTS). */
  allowedHosts?: string[]
}

export interface OriginGuard {
  /**
   * Call at the top of every HTTP request handler (guards `/api/*` only).
   * Returns true when the response has been handled (a 403 was written; caller
   * must not write again). Returns false when the request may proceed.
   */
  checkHttp: (req: IncomingMessage, res: ServerResponse) => boolean
  /** Returns true when a WebSocket upgrade request should be allowed. */
  allowUpgrade: (req: IncomingMessage) => boolean
  /** Exposed for the CORS reflector + tests. Absent/empty origin ⇒ true. */
  isAllowedOrigin: (origin?: string) => boolean
  /** Exposed for tests. Absent host ⇒ false. */
  isAllowedHost: (host?: string) => boolean
}

// ─── Header + URL helpers ─────────────────────────────────────────────────────

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const v = req.headers[name]
  if (Array.isArray(v)) return v[0]
  return typeof v === 'string' ? v : undefined
}

function pathnameOf(url: string | undefined): string {
  const raw = typeof url === 'string' ? url : ''
  const q = raw.indexOf('?')
  return (q === -1 ? raw : raw.slice(0, q)) || '/'
}

/** Wrap a bare IPv6 literal in brackets so `new URL` can parse it as a host. */
function bracketIfIpv6(host: string): string {
  if (host.startsWith('[')) return host
  if ((host.match(/:/g)?.length ?? 0) > 1) return `[${host}]`
  return host
}

/** Normalize an origin to its canonical `scheme://host[:port]` form, or null. */
function normalizeOrigin(raw: string): string | null {
  try {
    const o = new URL(raw).origin
    // A URL with no meaningful origin (e.g. `file:`, `data:`) yields the opaque
    // string 'null' — never a trusted origin.
    if (!o || o === 'null') return null
    return o
  } catch {
    return null
  }
}

/** Extract the lowercased, bracket-stripped, trailing-dot-stripped hostname. */
function parseHostname(host: string | undefined): string {
  let raw = String(host ?? '').trim()
  if (!raw) return ''
  // A bare IPv6 (multiple colons, unbracketed) must be bracketed before `new URL`.
  if (!raw.startsWith('[') && (raw.match(/:/g)?.length ?? 0) > 1) {
    raw = `[${raw}]`
  }
  let hostname: string
  try {
    hostname = new URL(`http://${raw}`).hostname
  } catch {
    hostname = raw
  }
  return hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '') // strip [..] from IPv6 literals
    .replace(/\.$/, '') // strip a single fully-qualified trailing dot
}

/** IPv4 loopback (127.0.0.0/8). Matches the recognition in lib/resolveHost.ts. */
const IPV4_LOOPBACK_RE = /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/

// ─── createOriginGuard ─────────────────────────────────────────────────────────

export function createOriginGuard(options: OriginGuardOptions): OriginGuard {
  const port = options.port
  const bindHost = String(options.bindHost ?? '127.0.0.1').trim() || '127.0.0.1'
  const dev = Boolean(options.dev)
  const devPort = options.devPort ?? 5173
  const allowedOrigins = options.allowedOrigins ?? []
  const allowedHosts = options.allowedHosts ?? []

  // ── Allowed ORIGIN set (exact match on the normalized origin) ──────────────
  const LOOPBACK_TOKENS = ['localhost', '127.0.0.1', '[::1]']
  const SCHEMES = ['http', 'https']
  const originSet = new Set<string>()
  const addOrigin = (scheme: string, hostToken: string, p: number): void => {
    const o = normalizeOrigin(`${scheme}://${hostToken}:${p}`)
    if (o) originSet.add(o)
  }
  for (const token of LOOPBACK_TOKENS) for (const s of SCHEMES) addOrigin(s, token, port)
  // Always trust the actual bind host at the API port — covers 127.x loopback
  // aliases AND a specific LAN-IP bind (the origin the browser would present).
  const bindHostToken = bracketIfIpv6(bindHost)
  for (const s of SCHEMES) addOrigin(s, bindHostToken, port)
  // Dev: the Vite dev server the SPA is loaded from (its requests carry that Origin).
  if (dev)
    for (const token of LOOPBACK_TOKENS) for (const s of SCHEMES) addOrigin(s, token, devPort)
  // Operator-supplied extras (widen only; unparseable entries are skipped).
  for (const raw of allowedOrigins) {
    const o = normalizeOrigin(raw)
    if (o) originSet.add(o)
  }

  // ── Allowed HOST set (hostname match) ──────────────────────────────────────
  const hostSet = new Set<string>(['localhost', '127.0.0.1', '::1'])
  const bindHostname = parseHostname(bindHostToken)
  if (bindHostname) hostSet.add(bindHostname)
  for (const raw of allowedHosts) {
    const hn = parseHostname(raw)
    if (hn) hostSet.add(hn)
  }

  function isAllowedOrigin(origin?: string): boolean {
    // No Origin header ⇒ a non-browser client (a browser sets Origin on every
    // cross-site WS handshake and state-changing fetch, and cannot forge it). The
    // cross-site *no-cors GET* residual (where a browser omits Origin) is closed by
    // the Sec-Fetch-Site check below.
    if (origin === undefined || origin === null) return true
    const trimmed = origin.trim()
    if (trimmed === '') return true
    const normalized = normalizeOrigin(trimmed)
    if (!normalized) return false // includes the opaque 'null' origin
    return originSet.has(normalized)
  }

  function isAllowedHost(host?: string): boolean {
    const hn = parseHostname(host)
    if (!hn) return false
    if (hostSet.has(hn)) return true
    return IPV4_LOOPBACK_RE.test(hn)
  }

  /**
   * Defense-in-depth for the cross-site no-cors-GET gap (a browser omits Origin
   * there). Browsers send Sec-Fetch-Site on EVERY request; non-browser clients
   * (CLI/MCP/Node) omit it. Absent ⇒ allow. Present ⇒ only same-origin/-site/none.
   */
  function isFetchSiteAllowed(req: IncomingMessage): boolean {
    const sfs = headerValue(req, 'sec-fetch-site')
    if (!sfs) return true
    const v = sfs.trim().toLowerCase()
    return v === 'same-origin' || v === 'same-site' || v === 'none'
  }

  function allowUpgrade(req: IncomingMessage): boolean {
    return (
      isAllowedHost(headerValue(req, 'host')) &&
      isAllowedOrigin(headerValue(req, 'origin')) &&
      isFetchSiteAllowed(req)
    )
  }

  function checkHttp(req: IncomingMessage, res: ServerResponse): boolean {
    // Guard the sensitive API surface only; the SPA HTML/static assets are public.
    // Lower-case the path (parity with access-gate.ts) as defense-in-depth.
    if (!pathnameOf(req.url).toLowerCase().startsWith('/api/')) return false

    if (
      isAllowedHost(headerValue(req, 'host')) &&
      isAllowedOrigin(headerValue(req, 'origin')) &&
      isFetchSiteAllowed(req)
    ) {
      return false
    }

    res.statusCode = 403
    res.setHeader('Content-Type', 'application/json')
    res.end(JSON.stringify({ error: 'Cross-origin request blocked.' }))
    return true
  }

  return { checkHttp, allowUpgrade, isAllowedOrigin, isAllowedHost }
}
