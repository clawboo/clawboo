// The identity lane: where a request's signed identity token is checked, and
// what happens to a request without one.
//
//   on        a token, when present, must verify, and names the person who made
//             the request. A request without one goes on as before: the access
//             token lets it in, and what it does is recorded with no name.
//   required  every /api/ request and the Gateway connection must carry a token
//             that verifies. A spawned runtime's own control-plane calls (the
//             attach-token lane the access gate admits) are the one exception:
//             they never come from a person.
//
// NEVER DOWNGRADED. A token that is present but does not verify (forged,
// expired, replayed, for another path) is refused with 401, in both modes. It
// never falls back to the access token as an unnamed person.
//
// This sits beside the access gate, after it: the access token still has to be
// right while the gate is on. An operator who wants the proxy instead of the
// access token sets this to `required` and turns the access token off.

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { NextFunction, Request, Response } from 'express'

import type { PersonRef } from '@clawboo/protocol'

import type { ProxyIdentityConfig } from './config'
import type { AssertionRefusal, AssertionVerifier } from './verifier'

/** The refusal's reason when a required token is missing. */
export type LaneRefusal = AssertionRefusal | 'missing'

export interface ProxyIdentityLane {
  mode: ProxyIdentityConfig['mode']
  /** Express middleware for every request. Sets `req.person` on a verified one. */
  http: (req: Request, res: Response, next: NextFunction) => void
  /** The Gateway connection's upgrade, which never passes through Express. */
  checkUpgrade: (req: IncomingMessage) => Promise<LaneDecision>
}

export type LaneDecision =
  { ok: true; person: PersonRef | null } | { ok: false; reason: LaneRefusal }

export interface LaneOptions {
  /** True for a spawned runtime's own `/api/mcp/*` call, as the access gate judges it. */
  isRuntimeRequest: (req: IncomingMessage) => boolean
  /** Told about every refusal, by reason only: never the token. */
  onRefuse?: (info: { reason: LaneRefusal; method: string; path: string }) => void
}

/** Recognised by "clawboo" and "token" like the access gate's 401, and by `gate`. */
export function laneRefusalBody(reason: LaneRefusal): string {
  return JSON.stringify({
    error:
      reason === 'missing'
        ? 'Clawboo needs a signed identity token from your sign-in proxy for this request.'
        : 'Clawboo refused the identity token from your sign-in proxy.',
    gate: 'clawboo-proxy-identity',
    reason,
  })
}

/**
 * The path of a request target as sent, without its query: an origin-form
 * target as it is, an absolute-form one (`GET http://host/api/x HTTP/1.1`) by
 * what follows its authority. Never resolved: Express routes this raw path,
 * dot segments and all. Null for a target with no path (`*`, authority-form).
 */
export function targetPath(url: string | undefined): string | null {
  const raw = url ?? '/'
  const end = raw.search(/[?#]/)
  const target = end === -1 ? raw : raw.slice(0, end)
  if (target.startsWith('/')) return target
  const absolute = /^[a-z][a-z0-9+.-]*:\/\/[^/]*(\/.*)?$/i.exec(target)
  return absolute ? (absolute[1] ?? '/') : null
}

/**
 * Every reading of a request's path that some layer acts on: as sent; as the
 * WHATWG URL parser resolves it, which is how the access gate reads it (dot
 * segments removed, an absolute-form target cut to its path); and as the router
 * matches it (`req.path`), when known. They differ for a dot segment: the gate
 * reads `/api/files/x/../../../x` as `/x`, while the router still sends it to an
 * `/api/` route. So the lane guards a request when ANY reading is under `/api/`,
 * and lets a runtime's credential stand in for a token only when EVERY reading
 * is under `/api/mcp/`.
 */
function pathReadings(url: string | undefined, routerPath?: string): Array<string | null> {
  let resolved: string | null
  try {
    resolved = new URL(url ?? '/', 'http://clawboo.invalid').pathname
  } catch {
    resolved = null
  }
  const sent = targetPath(url)
  return [sent, resolved, routerPath ?? sent]
}

/** Under `prefix`, letter case folded as the access gate folds it. */
const under =
  (prefix: string) =>
  (path: string | null): boolean =>
    path !== null && path.toLowerCase().startsWith(prefix)

/** The token from the header, without a `Bearer ` prefix. Undefined when absent;
 *  '' when present but empty, or sent twice (Node joins repeats with a comma). */
function tokenFrom(req: IncomingMessage, header: string): string | undefined {
  const value = req.headers[header]
  if (value === undefined) return undefined
  const text = (Array.isArray(value) ? value.join(',') : value).trim()
  const token = /^bearer\s+/i.test(text) ? text.replace(/^bearer\s+/i, '') : text
  return token.includes(',') ? '' : token
}

export function createProxyIdentityLane(
  config: ProxyIdentityConfig,
  verifier: AssertionVerifier,
  opts: LaneOptions,
): ProxyIdentityLane {
  const required = config.mode === 'required'

  /** `path` is the one the request arrived with, the base path included: the
   *  path the proxy signed. */
  async function decide(req: IncomingMessage, path: string): Promise<LaneDecision> {
    const token = tokenFrom(req, config.header)
    if (token === undefined) {
      return required ? { ok: false, reason: 'missing' } : { ok: true, person: null }
    }
    if (token === '') return { ok: false, reason: 'malformed' }
    try {
      const result = await verifier.verify({ token, method: req.method ?? 'GET', path })
      return result.ok ? { ok: true, person: result.person } : result
    } catch {
      return { ok: false, reason: 'malformed' }
    }
  }

  function refuse(res: ServerResponse, reason: LaneRefusal): void {
    res.statusCode = 401
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(laneRefusalBody(reason))
  }

  function http(req: Request, res: Response, next: NextFunction): void {
    // After the base-path strip, so `req.url` is root-form for an origin-form
    // target. Every reading of it counts (see pathReadings): no letter case,
    // dot segment or absolute-form target routes past the lane.
    const readings = pathReadings(req.url, typeof req.path === 'string' ? req.path : undefined)
    if (!readings.some(under('/api/'))) {
      next()
      return
    }
    if (readings.every(under('/api/mcp/')) && opts.isRuntimeRequest(req)) {
      next()
      return
    }
    // The path as the request arrived, base path included: the one the proxy
    // signed. An absolute-form target is cut to its path; nothing is resolved.
    const path = targetPath(req.originalUrl ?? req.url) ?? ''
    void decide(req, path).then((decision) => {
      if (!decision.ok) {
        opts.onRefuse?.({ reason: decision.reason, method: req.method, path })
        refuse(res, decision.reason)
        return
      }
      req.person = decision.person
      next()
    })
  }

  async function checkUpgrade(req: IncomingMessage): Promise<LaneDecision> {
    const path = targetPath(req.url) ?? ''
    const decision = await decide(req, path)
    if (!decision.ok)
      opts.onRefuse?.({ reason: decision.reason, method: req.method ?? 'GET', path })
    return decision
  }

  return { mode: config.mode, http, checkUpgrade }
}
