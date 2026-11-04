import type { IncomingMessage } from 'node:http'
import { URL } from 'node:url'

// ─── Request path readings ─────────────────────────────────────────────────
//
// The access gate and the origin guard decide what to protect from a request's
// path, and the router decides where to send it. They do not read a path the
// same way. The WHATWG URL parser removes dot segments (in any spelling,
// percent-encoded ones included) and reads a backslash as a slash. Express
// routes the path as sent, except that for some targets its parser turns
// backslashes into slashes while keeping the dot segments. A guard that reads
// one form while the router acts on another can wave a request through to a
// route it was meant to protect.
//
// So a guard asks about every reading at once: it protects a request when ANY
// reading is under a protected prefix, and grants an exemption only when EVERY
// reading is under the exempt one.

/** Parses a path-only target. Only the path and query are ever read from it. */
const PARSE_BASE = 'http://clawboo.invalid'

/**
 * The path of a request target as sent, without its query or fragment: an
 * origin-form target as it is, an absolute-form one (`http://host/path`) by
 * what follows its authority. Nothing is resolved or decoded. Null for a target
 * with no path (`*`, authority-form, anything else).
 */
export function targetPath(url: string | undefined): string | null {
  const raw = url ?? '/'
  const end = raw.search(/[?#]/)
  const target = end === -1 ? raw : raw.slice(0, end)
  if (target.startsWith('/')) return target
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(target)
  return absolute ? (absolute[1] ?? '/') : null
}

/** The path the host framework routes by, when it publishes one (Express's
 *  `req.path`). Null when it does not, or cannot parse the target. */
function routedPath(req: IncomingMessage): string | null {
  try {
    const path = (req as { path?: unknown }).path
    return typeof path === 'string' ? path : null
  } catch {
    return null
  }
}

/**
 * Every reading of a request's path that a guard or the router acts on: as
 * sent; as sent with backslashes read as slashes, when it has any; as the WHATWG
 * URL parser resolves it; and as the router matches it, when known. A reading
 * that cannot be taken is null, which is under no prefix.
 */
export function requestPathReadings(req: IncomingMessage): Array<string | null> {
  const url = req.url ?? '/'
  const readings: Array<string | null> = [targetPath(url)]
  if (url.includes('\\')) readings.push(targetPath(url.replace(/\\/g, '/')))
  try {
    readings.push(new URL(url, PARSE_BASE).pathname)
  } catch {
    readings.push(null)
  }
  const routed = routedPath(req)
  if (routed !== null) readings.push(routed)
  return readings
}

/** Under `prefix`, letter case folded. */
const under =
  (prefix: string) =>
  (path: string | null): boolean =>
    path !== null && path.toLowerCase().startsWith(prefix)

/** True when ANY reading of the request's path is under `prefix` (lower case),
 *  in any letter case. What a guard protects. */
export function anyPathUnder(req: IncomingMessage, prefix: string): boolean {
  return requestPathReadings(req).some(under(prefix))
}

/** True when EVERY reading of the request's path is under `prefix` (lower case),
 *  in any letter case. What an exemption needs. */
export function everyPathUnder(req: IncomingMessage, prefix: string): boolean {
  return requestPathReadings(req).every(under(prefix))
}

/**
 * True when the request target is a path (origin-form), or `*` on an OPTIONS
 * request. Browsers, reverse proxies and every Clawboo client send a path. A
 * whole URL (absolute-form) is what a client sends to a forward proxy, which
 * this server is not.
 */
export function isOriginFormTarget(req: IncomingMessage): boolean {
  const url = req.url ?? '/'
  if (url.startsWith('/')) return true
  return url === '*' && String(req.method ?? '').toUpperCase() === 'OPTIONS'
}
