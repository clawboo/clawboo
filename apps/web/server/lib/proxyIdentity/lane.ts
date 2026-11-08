// The identity lane: where a request's signed identity token is checked, and
// what happens to a request without one.
//
//   on        a token, when present, must verify, and names the person who made
//             the request. A request without one goes on as before: the access
//             token lets it in, and what it does is recorded with no name.
//   required  every /api/ request and the Gateway connection must carry a token
//             that verifies. A spawned runtime's own control-plane calls (the
//             attach-token lane the access gate admits) are the one exception:
//             they never come from a person, and carry no token. One that does
//             carry a token is checked like any other request.
//
// NEVER DOWNGRADED. A token that is present but does not verify (forged,
// expired, replayed, for another path) is refused with 401, in both modes. It
// never falls back to the access token as an unnamed person.
//
// This sits beside the access gate, after it: the access token still has to be
// right while the gate is on. An operator who wants the proxy instead of the
// access token sets this to `required` and turns the access token off.
//
// It reads one header per issuer: the sign-in proxy's and the app link's (see
// config.ts). A request carries at most one token. One that carries both is
// refused, so nothing has to choose which of two people sent it. The app link
// never makes a token required: its mode is always `on`.
//
// The app link's token is for /api/ requests only, never the Gateway
// WebSocket. Messages on that socket are not checked one by one, so an answer
// sent there would skip what an app's person may not do (allow an approval
// always); an upgrade that carries the app's token is refused.

import type { IncomingMessage, ServerResponse } from 'node:http'

import type { NextFunction, Request, Response } from 'express'

import { anyPathUnder, everyPathUnder, targetPath } from '@clawboo/gateway-proxy'
import type { PersonRef } from '@clawboo/protocol'

import type { ProxyIdentityConfig } from './config'
import type { AssertionRefusal, AssertionVerifier } from './verifier'

/** The refusal's reason: a verifier's, `missing` when a required token is
 *  absent, `two-tokens` when a request carries both issuers' tokens. */
export type LaneRefusal = AssertionRefusal | 'missing' | 'two-tokens'

/** One issuer the lane trusts: its settings and the verifier built from them. */
export interface LaneSource {
  config: ProxyIdentityConfig
  verifier: AssertionVerifier
}

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

/** Recognised by "clawboo" and "token" like the access gate's 401, and by `gate`.
 *  `from` names whose token was refused, when one was. */
export function laneRefusalBody(reason: LaneRefusal, from: 'proxy' | 'app' = 'proxy'): string {
  return JSON.stringify({
    error:
      reason === 'missing'
        ? 'Clawboo needs a signed identity token from your sign-in proxy for this request.'
        : reason === 'two-tokens'
          ? 'Clawboo refused a request that carries two identity tokens. Send one.'
          : from === 'app'
            ? 'Clawboo refused the identity token from the app that started it.'
            : 'Clawboo refused the identity token from your sign-in proxy.',
    gate: 'clawboo-proxy-identity',
    reason,
  })
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

/** The lane for one issuer: a sign-in proxy's alone. */
export function createProxyIdentityLane(
  config: ProxyIdentityConfig,
  verifier: AssertionVerifier,
  opts: LaneOptions,
): ProxyIdentityLane {
  return createIdentityLane([{ config, verifier }], opts)
}

type Decided = LaneDecision & { from?: 'proxy' | 'app' }

/** The lane for every issuer the engine trusts: the sign-in proxy's, the app
 *  link's, or both. Each reads its own header. */
export function createIdentityLane(sources: LaneSource[], opts: LaneOptions): ProxyIdentityLane {
  if (sources.length === 0) throw new Error('an identity lane needs at least one issuer')
  const headers = new Set(sources.map((s) => s.config.header))
  if (headers.size !== sources.length) throw new Error('two issuers share one header')
  const required = sources.some((s) => s.config.mode === 'required')
  const fromOf = (source: LaneSource): 'proxy' | 'app' =>
    source.config.accountSubjects === 'only' ? 'app' : 'proxy'
  const carriesToken = (req: IncomingMessage): boolean =>
    sources.some((s) => tokenFrom(req, s.config.header) !== undefined)

  const upgradeSources = sources.filter((s) => fromOf(s) === 'proxy')
  const appSources = sources.filter((s) => fromOf(s) === 'app')

  /** `path` is the one the request arrived with, the base path included: the
   *  path the proxy signed. `pool` is the issuers whose tokens count here. */
  async function decide(
    req: IncomingMessage,
    path: string,
    pool: LaneSource[] = sources,
  ): Promise<Decided> {
    const carried = pool
      .map((source) => ({ source, token: tokenFrom(req, source.config.header) }))
      .filter((c): c is { source: LaneSource; token: string } => c.token !== undefined)
    if (carried.length === 0) {
      return required ? { ok: false, reason: 'missing' } : { ok: true, person: null }
    }
    if (carried.length > 1) return { ok: false, reason: 'two-tokens' }
    const { source, token } = carried[0]!
    const from = fromOf(source)
    if (token === '') return { ok: false, reason: 'malformed', from }
    try {
      const result = await source.verifier.verify({ token, method: req.method ?? 'GET', path })
      return result.ok ? { ok: true, person: result.person } : { ...result, from }
    } catch {
      return { ok: false, reason: 'malformed', from }
    }
  }

  function refuse(res: ServerResponse, reason: LaneRefusal, from?: 'proxy' | 'app'): void {
    res.statusCode = 401
    res.setHeader('Content-Type', 'application/json')
    res.setHeader('Cache-Control', 'no-store')
    res.end(laneRefusalBody(reason, from))
  }

  function http(req: Request, res: Response, next: NextFunction): void {
    // After the base-path strip, so `req.url` is root-form for an origin-form
    // target. Every reading of the path counts, as in the access gate (see
    // @clawboo/gateway-proxy's request-path): no letter case, dot segment,
    // backslash or absolute-form target routes past the lane.
    if (!anyPathUnder(req, '/api/')) {
      next()
      return
    }
    // A runtime's own control-plane call carries no identity token. One that
    // does is checked like any other: a bad token is refused on every path.
    if (everyPathUnder(req, '/api/mcp/') && !carriesToken(req) && opts.isRuntimeRequest(req)) {
      next()
      return
    }
    // The path as the request arrived, base path included: the one the proxy
    // signed. An absolute-form target is cut to its path; nothing is resolved.
    const path = targetPath(req.originalUrl ?? req.url) ?? ''
    void decide(req, path).then((decision) => {
      if (!decision.ok) {
        opts.onRefuse?.({ reason: decision.reason, method: req.method, path })
        refuse(res, decision.reason, decision.from)
        return
      }
      req.person = decision.person
      next()
    })
  }

  async function checkUpgrade(req: IncomingMessage): Promise<LaneDecision> {
    const path = targetPath(req.url) ?? ''
    const appToken = appSources.some((s) => tokenFrom(req, s.config.header) !== undefined)
    const decision: Decided = appToken
      ? { ok: false, reason: 'binding' }
      : await decide(req, path, upgradeSources)
    if (decision.ok) return { ok: true, person: decision.person }
    opts.onRefuse?.({ reason: decision.reason, method: req.method ?? 'GET', path })
    return { ok: false, reason: decision.reason }
  }

  return { mode: required ? 'required' : 'on', http, checkUpgrade }
}
