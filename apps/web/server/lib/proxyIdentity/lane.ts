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

function pathOf(url: string | undefined): string {
  const raw = url ?? '/'
  const q = raw.indexOf('?')
  return q === -1 ? raw : raw.slice(0, q)
}

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
    // Root-form, after the base-path strip: the same test the access gate makes,
    // case folded the same way so `/API/...` cannot step around it.
    if (!pathOf(req.url).toLowerCase().startsWith('/api/')) {
      next()
      return
    }
    if (opts.isRuntimeRequest(req)) {
      next()
      return
    }
    const path = pathOf(req.originalUrl ?? req.url)
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
    const path = pathOf(req.url)
    const decision = await decide(req, path)
    if (!decision.ok)
      opts.onRefuse?.({ reason: decision.reason, method: req.method ?? 'GET', path })
    return decision
  }

  return { mode: config.mode, http, checkUpgrade }
}
