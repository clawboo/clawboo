// Verify one identity token from the sign-in proxy, and say who it names.
//
// WHAT A GOOD TOKEN IS
//   - a compact JWS signed with an asymmetric algorithm (EdDSA, ES*, RS*, PS*),
//     by a key from the operator's JWKS URL or public key. Never `none` and
//     never HMAC: with only public keys here, an HMAC token "signed" with the
//     public key as its secret is the classic forgery, and it is refused by
//     algorithm before any key is looked at;
//   - the operator's issuer and audience;
//   - a `sub` (the person's id). An app link's `sub` must start with `account:`,
//     and while one is on, a sign-in proxy's never may (accountSubjects);
//   - not expired, and not issued in the future, within CLOCK_SKEW_SECONDS.
//
// REQUEST BINDING (the default) asks more of every token: `htm` and `htu` (the
// request's method and path, as in DPoP, RFC 9449), `iat`, `exp` no more than
// the operator's maximum lifetime after `iat`, and a `jti` that is accepted
// once. A copied token is then good for one request, to one path, for seconds.
// SESSION BINDING is for proxies that send their own sign-in token on every
// request (Cloudflare Access, oauth2-proxy): such a token is good until it
// expires, on any path. `htm` and `htu` are still checked when present.

import {
  createLocalJWKSet,
  createRemoteJWKSet,
  decodeProtectedHeader,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
} from 'jose'

import { ACCOUNT_PERSON_PREFIX, isAccountPerson } from '@clawboo/board-core'
import type { PersonRef } from '@clawboo/protocol'

import type { ProxyIdentityConfig } from './config'

/** Asymmetric signatures only. */
export const ALLOWED_ALGORITHMS = [
  'EdDSA',
  'Ed25519',
  'ES256',
  'ES384',
  'ES512',
  'RS256',
  'RS384',
  'RS512',
  'PS256',
  'PS384',
  'PS512',
] as const

/** How far apart the proxy's clock and this one may be. */
export const CLOCK_SKEW_SECONDS = 5

/** Larger than any real token, small enough that a junk header costs nothing. */
const MAX_TOKEN_CHARS = 16 * 1024
/** Three base64url segments; the signature may be empty so `alg: none` is named
 *  as such below rather than lumped in with junk. */
const COMPACT_JWS = /^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*$/
const MAX_ID_CHARS = 256
const MAX_NAME_CHARS = 200
const MAX_ROLE_CHARS = 200
/** Request-bound tokens held for the replay check. Each lives at most 5 minutes. */
const MAX_SEEN_TOKENS = 100_000

export type AssertionRefusal =
  /** Not a compact JWS, or a header or payload that does not parse. */
  | 'malformed'
  /** `none`, HMAC, or any other algorithm outside the asymmetric list. */
  | 'algorithm'
  /** The signature does not verify, or no key of the proxy's matches it. */
  | 'signature'
  | 'issuer'
  | 'audience'
  | 'expired'
  /** Issued or valid only in the future. */
  | 'not-yet-valid'
  /** A request-bound token that lives longer than the operator allows. */
  | 'lifetime'
  /** For another method or path. */
  | 'binding'
  /** A request-bound token seen before. */
  | 'replayed'
  /** A required claim is missing or of the wrong type. */
  | 'claims'
  /** The proxy's keys could not be fetched. */
  | 'keys-unavailable'

export type AssertionResult =
  { ok: true; person: PersonRef } | { ok: false; reason: AssertionRefusal }

export interface AssertionInput {
  token: string
  /** The request's method. */
  method: string
  /** The request's path as Clawboo received it (any query is ignored). */
  path: string
}

export interface AssertionVerifier {
  verify: (input: AssertionInput) => Promise<AssertionResult>
}

export interface VerifierOptions {
  /** Epoch ms. Defaults to `Date.now`. */
  now?: () => number
  /** Replaces the key lookup the config names. Tests. */
  getKey?: JWTVerifyGetKey
}

/** A path without its query or fragment, exactly as written. */
function rawPath(value: string): string {
  const end = value.search(/[?#]/)
  return end === -1 ? value : value.slice(0, end)
}

/**
 * The path `htu` names: a path as written, or an absolute http(s) URL's path.
 * Never normalized further: the router matches the raw path, so a token for
 * `/api/board` must not stretch to `/api/x/../board`. A URL whose parsed path
 * differs from its raw spelling, dot segments included, binds to nothing.
 */
function boundPath(htu: string): string | null {
  if (htu.startsWith('/')) return htu.startsWith('//') ? null : rawPath(htu)
  let url: URL
  try {
    url = new URL(htu)
  } catch {
    return null
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null
  const written = rawPath(htu.slice(htu.indexOf('//') + 2))
  const slash = written.indexOf('/')
  return slash !== -1 && written.slice(slash) === url.pathname ? url.pathname : null
}

function claimAt(payload: JWTPayload, path: string): unknown {
  let value: unknown = payload
  for (const part of path.split('.')) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return undefined
    value = (value as Record<string, unknown>)[part]
  }
  return value
}

/** Printable text, trimmed and capped: names reach logs and the dashboard. */
function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null
  // eslint-disable-next-line no-control-regex
  const text = value.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return text ? text.slice(0, max) : null
}

function roleOf(value: unknown): string | null {
  if (Array.isArray(value)) {
    const words = value.map((v) => cleanText(v, MAX_ROLE_CHARS)).filter((v) => v !== null)
    return words.length > 0 ? words.join(', ').slice(0, MAX_ROLE_CHARS) : null
  }
  return cleanText(value, MAX_ROLE_CHARS)
}

function refusalOf(err: unknown): AssertionRefusal {
  const code = (err as { code?: unknown } | null)?.code
  const claim = (err as { claim?: unknown } | null)?.claim
  switch (code) {
    case 'ERR_JOSE_ALG_NOT_ALLOWED':
    case 'ERR_JOSE_NOT_SUPPORTED':
      return 'algorithm'
    case 'ERR_JWS_SIGNATURE_VERIFICATION_FAILED':
    case 'ERR_JWKS_NO_MATCHING_KEY':
    case 'ERR_JWKS_MULTIPLE_MATCHING_KEYS':
      return 'signature'
    case 'ERR_JWT_EXPIRED':
      return 'expired'
    case 'ERR_JWKS_TIMEOUT':
    case 'ERR_JWKS_INVALID':
      return 'keys-unavailable'
    case 'ERR_JWT_CLAIM_VALIDATION_FAILED': {
      const reason = (err as { reason?: unknown }).reason
      if (claim === 'iss') return 'issuer'
      if (claim === 'aud') return 'audience'
      if ((claim === 'nbf' || claim === 'iat') && reason === 'check_failed') return 'not-yet-valid'
      return 'claims'
    }
    case 'ERR_JWS_INVALID':
    case 'ERR_JWT_INVALID':
      return 'malformed'
    default:
      // A fetch that failed outright (DNS, refused, TLS) comes back untyped.
      return code === undefined && err instanceof TypeError ? 'keys-unavailable' : 'malformed'
  }
}

export function createAssertionVerifier(
  config: ProxyIdentityConfig,
  opts: VerifierOptions = {},
): AssertionVerifier {
  const now = opts.now ?? Date.now
  const getKey: JWTVerifyGetKey =
    opts.getKey ??
    (config.keys.source === 'jwks-url'
      ? createRemoteJWKSet(config.keys.url, {
          timeoutDuration: 5_000,
          cooldownDuration: 30_000,
          cacheMaxAge: 10 * 60_000,
        })
      : createLocalJWKSet(config.keys.jwks))
  const requestBound = config.binding === 'request'

  // jti -> when it stops mattering (epoch ms), oldest first.
  const seen = new Map<string, number>()
  let lastSweep = 0
  function sweep(at: number): void {
    if (at - lastSweep < 1_000 && seen.size < MAX_SEEN_TOKENS) return
    lastSweep = at
    for (const [jti, until] of seen) if (until <= at) seen.delete(jti)
  }

  async function verify(input: AssertionInput): Promise<AssertionResult> {
    const token = input.token.trim()
    if (token.length > MAX_TOKEN_CHARS || !COMPACT_JWS.test(token)) {
      return { ok: false, reason: 'malformed' }
    }
    // Checked before any key is touched, so `none` and HMAC never reach a key
    // lookup, whatever the verifier below would make of them.
    let alg: unknown
    try {
      alg = decodeProtectedHeader(token).alg
    } catch {
      return { ok: false, reason: 'malformed' }
    }
    if (typeof alg !== 'string' || !(ALLOWED_ALGORITHMS as readonly string[]).includes(alg)) {
      return { ok: false, reason: 'algorithm' }
    }

    const at = now()
    let payload: JWTPayload
    try {
      ;({ payload } = await jwtVerify(token, getKey, {
        algorithms: [...ALLOWED_ALGORITHMS],
        issuer: config.issuer,
        audience: config.audience,
        clockTolerance: CLOCK_SKEW_SECONDS,
        currentDate: new Date(at),
        requiredClaims: requestBound ? ['sub', 'exp', 'iat', 'jti', 'htm', 'htu'] : ['sub', 'exp'],
        ...(requestBound ? { maxTokenAge: config.maxLifetimeSeconds } : {}),
      }))
    } catch (err) {
      return { ok: false, reason: refusalOf(err) }
    }

    const sub = cleanText(payload.sub, MAX_ID_CHARS)
    if (!sub || sub !== payload.sub) return { ok: false, reason: 'claims' }
    // Each issuer keeps to its own people. A proxy naming an `account:` person
    // would pass for the app link's, and an app link naming anyone else would
    // pass for the proxy's.
    if (config.accountSubjects === 'only' && !isAccountPerson(sub)) {
      return { ok: false, reason: 'claims' }
    }
    if (config.accountSubjects === 'never' && sub.startsWith(ACCOUNT_PERSON_PREFIX)) {
      return { ok: false, reason: 'claims' }
    }
    const nowSeconds = at / 1000
    if (typeof payload.iat === 'number' && payload.iat > nowSeconds + CLOCK_SKEW_SECONDS) {
      return { ok: false, reason: 'not-yet-valid' }
    }

    if (requestBound) {
      const { iat, exp } = payload as { iat: number; exp: number }
      if (exp - iat > config.maxLifetimeSeconds) return { ok: false, reason: 'lifetime' }
    }

    // The binding, checked whenever the token carries one.
    const { htm, htu } = payload as { htm?: unknown; htu?: unknown }
    if (htm !== undefined || htu !== undefined) {
      if (typeof htm !== 'string' || typeof htu !== 'string') return { ok: false, reason: 'claims' }
      if (htm.toUpperCase() !== input.method.toUpperCase()) return { ok: false, reason: 'binding' }
      if (boundPath(htu) !== rawPath(input.path)) return { ok: false, reason: 'binding' }
    }

    if (requestBound) {
      const jti = payload.jti
      if (typeof jti !== 'string' || jti === '' || jti.length > MAX_ID_CHARS) {
        return { ok: false, reason: 'claims' }
      }
      sweep(at)
      if (seen.has(jti)) return { ok: false, reason: 'replayed' }
      // Full: refuse rather than forget a token that could then be replayed.
      if (seen.size >= MAX_SEEN_TOKENS) return { ok: false, reason: 'replayed' }
      // Kept until jose would refuse the token as expired. It reads the clock in
      // whole seconds, so a fractional exp is good until ceil(exp) + skew; a
      // record dropped at exp + skew would let the token through once more.
      seen.set(jti, (Math.ceil(payload.exp as number) + CLOCK_SKEW_SECONDS) * 1000)
    }

    const name =
      cleanText(claimAt(payload, config.nameClaim), MAX_NAME_CHARS) ??
      cleanText(payload['email'], MAX_NAME_CHARS) ??
      cleanText(payload['preferred_username'], MAX_NAME_CHARS)
    const role = roleOf(claimAt(payload, config.roleClaim))
    return { ok: true, person: { id: sub, name, role } }
  }

  return { verify }
}
