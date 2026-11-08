// The identity lane's settings, read once at startup from the operator settings
// (the file or the environment, never the dashboard), and checked hard.
//
// PUBLIC KEYS ONLY. Agents run as Clawboo's own OS user, so anything Clawboo can
// read, an agent can read. A shared secret held here would let an agent sign a
// token as anyone. The lane therefore takes a JWKS URL or a public key, refuses
// private key material outright, and accepts only asymmetric signatures.
//
// FAIL-CLOSED. A lane that is on but cannot be trusted (no key, no issuer, no
// audience, a key it cannot read, a JWKS URL over plain http to another host)
// stops the server at startup, like every other operator setting: starting
// without it would let anyone with the access token act as an unnamed person.
//
// TWO ISSUERS. Beside a sign-in proxy, an app that starts this engine itself (a
// desktop app) can name the person a request comes from: its app link. It signs
// with its own Ed25519 key, whose public half it hands the engine in
// CLAWBOO_APP_LINK_PUBLIC_KEY when it starts it, sends its token in a header of
// its own, and may only name `account:` people. While it is on, a proxy may
// never name one.
// That key is read from the environment and nowhere else: the operator file is
// a file an agent could change, and an app link is only ever set up by the app
// that launches the engine.

import { createPublicKey, type webcrypto } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

import type { JSONWebKeySet, JWK } from 'jose'

import {
  OPERATOR_KEYS,
  OperatorSettingsError,
  effectiveSetting,
  operatorFileLocation,
  type OperatorKey,
} from '../operatorSettings'

export type ProxyIdentityMode = 'off' | 'on' | 'required'
export type ProxyIdentityBinding = 'request' | 'session'

export type ProxyIdentityKeys =
  { source: 'jwks-url'; url: URL } | { source: 'public-key'; jwks: JSONWebKeySet }

export interface ProxyIdentityConfig {
  /** `on`: a token is checked when a request carries one. `required`: every
   *  dashboard request must carry a good one. */
  mode: Exclude<ProxyIdentityMode, 'off'>
  /** The header that carries the token, lower-cased. */
  header: string
  issuer: string
  audience: string
  binding: ProxyIdentityBinding
  /** The longest `exp - iat` a request-bound token may have, in seconds. */
  maxLifetimeSeconds: number
  nameClaim: string
  roleClaim: string
  keys: ProxyIdentityKeys
  /** `only`: every token must name an `account:` person (an app link).
   *  `never`: no token may (a sign-in proxy beside an app link), so the two cannot
   *  pass for each other. `any`: no rule (a sign-in proxy on its own, so a proxy
   *  that already names such people keeps working). */
  accountSubjects: 'only' | 'never' | 'any'
  /** The only routes a token from this issuer may be used on, when it is limited
   *  (the app link). Unset: any route (a sign-in proxy). */
  routes?: readonly AppLinkRoute[]
}

/** A route an app link's token may be used on: a method and a whole-path pattern. */
export interface AppLinkRoute {
  method: string
  path: RegExp
}

/** One path segment that is not a dot segment. */
const SEGMENT = '(?!\\.\\.?(?:/|$))[^/]+'

/**
 * What the app that started the engine signs for, and nothing else: sending
 * work to an agent or a team, answering an approval, and checking its link.
 * Its people may not change who is asked about what (grants, an agent's
 * posture, standing rules) or any other setting, so that a key copied from the
 * computer the app runs on cannot mint standing permissions.
 */
export const APP_LINK_ROUTES: readonly AppLinkRoute[] = [
  { method: 'GET', path: /^\/api\/access\/identity$/i },
  { method: 'POST', path: new RegExp(`^/api/agents/${SEGMENT}/chat$`, 'i') },
  { method: 'POST', path: new RegExp(`^/api/teams/${SEGMENT}/chat$`, 'i') },
  { method: 'POST', path: new RegExp(`^/api/tools/approvals/${SEGMENT}/resolve$`, 'i') },
  { method: 'POST', path: /^\/api\/capabilities\/approve$/i },
]

/** The header an app link's token travels in. Its own, so a sign-in proxy's
 *  header can be anything and the two never meet. */
export const APP_LINK_HEADER = 'clawboo-app-identity'
/** The `iss` and `aud` an app link's token carries. The key is the app's alone
 *  and trusted for nothing else, so these say what kind of token it is. */
export const APP_LINK_ISSUER = 'clawboo-app-link'
export const APP_LINK_AUDIENCE = 'clawboo-engine'
/** The environment variable that holds the app link's public key. */
export const APP_LINK_KEY_ENV = 'CLAWBOO_APP_LINK_PUBLIC_KEY'

/** A header name: an HTTP token, and none Clawboo or a browser already gives a meaning. */
const HEADER_NAME = /^[A-Za-z0-9-]{1,64}$/
const RESERVED_HEADERS = new Set([
  'cookie',
  'host',
  'origin',
  'referer',
  'content-type',
  'content-length',
  'connection',
  'upgrade',
  'forwarded',
  'x-forwarded-for',
  'x-forwarded-host',
  'x-forwarded-proto',
  'x-real-ip',
])

/** A claim name, or a dotted path into nested claims (`realm_access.roles`). */
const CLAIM_PATH = /^[A-Za-z0-9_:$-]+(\.[A-Za-z0-9_:$-]+){0,4}$/

/** JWK members that only a private or a symmetric key has. */
const PRIVATE_MEMBERS = ['d', 'p', 'q', 'dp', 'dq', 'qi', 'oth', 'k'] as const

const EC_CURVES = new Set(['P-256', 'P-384', 'P-521'])
/** The algorithms each key can verify, for a JWK that names its own `alg`. */
const KEY_ALGS: Record<string, readonly string[]> = {
  OKP: ['EdDSA', 'Ed25519'],
  RSA: ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512'],
}
const EC_ALGS: Record<string, readonly string[]> = {
  'P-256': ['ES256'],
  'P-384': ['ES384'],
  'P-521': ['ES512'],
}
const MIN_RSA_BITS = 2048

function fail(message: string): never {
  throw new OperatorSettingsError(message)
}

/** Check one JWK and return the members a verifier needs. Never echoes key material.
 *  `holder` names who keeps the private key, for the error. */
function checkJwk(raw: unknown, where: string, holder: string): JWK {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${where} must be a JSON Web Key object.`)
  }
  const jwk = raw as Record<string, unknown>
  for (const member of PRIVATE_MEMBERS) {
    if (member in jwk) {
      fail(
        `${where} holds a private or shared key. Clawboo needs only ${holder}'s public key; ` +
          `keep the private key with ${holder}.`,
      )
    }
  }
  const kty = jwk['kty']
  if (kty !== 'RSA' && kty !== 'EC' && kty !== 'OKP') {
    fail(`${where} must be an RSA, EC or Ed25519 public key.`)
  }
  if (kty === 'OKP' && jwk['crv'] !== 'Ed25519') {
    fail(`${where} must use the Ed25519 curve.`)
  }
  if (kty === 'EC' && !EC_CURVES.has(String(jwk['crv']))) {
    fail(`${where} must use the P-256, P-384 or P-521 curve.`)
  }
  if (jwk['use'] !== undefined && jwk['use'] !== 'sig') {
    fail(`${where} is not a signing key ("use" must be "sig").`)
  }
  let detail: { modulusLength?: number } | undefined
  try {
    detail = createPublicKey({
      key: jwk as webcrypto.JsonWebKey,
      format: 'jwk',
    }).asymmetricKeyDetails
  } catch {
    fail(`${where} is not a key Clawboo can read.`)
  }
  if (kty === 'RSA' && (detail?.modulusLength ?? 0) < MIN_RSA_BITS) {
    fail(`${where} is an RSA key shorter than ${MIN_RSA_BITS} bits.`)
  }
  // A key set ignores a key whose `alg` does not fit it, so a wrong one would
  // pass startup and then refuse every token as a bad signature.
  const alg = jwk['alg']
  if (alg !== undefined) {
    const fits = kty === 'EC' ? EC_ALGS[String(jwk['crv'])] : KEY_ALGS[kty]
    if (typeof alg !== 'string' || !fits?.includes(alg)) {
      fail(
        `${where} names "alg" ${JSON.stringify(alg)}, which its key cannot sign with. ` +
          `Use ${(fits ?? []).join(', ')}, or leave "alg" out.`,
      )
    }
  }
  const out: JWK = { kty }
  for (const member of ['crv', 'x', 'y', 'n', 'e', 'kid', 'alg', 'use'] as const) {
    const value = jwk[member]
    if (typeof value === 'string') out[member] = value
  }
  return out
}

/**
 * The public key setting as a key set: a PEM public key, a JWK, or a JWKS.
 * Literal `\n` sequences count as line breaks, so a PEM fits in one environment
 * variable. Private keys, certificates and symmetric keys are refused.
 */
export function parsePublicKeySetting(
  raw: string,
  where: string,
  holder = 'the proxy',
): JSONWebKeySet {
  // Trimmed again after: a PEM written with an escaped trailing newline ends in one.
  const text = raw.trim().replace(/\\n/g, '\n').trim()
  if (/PRIVATE KEY/.test(text)) {
    fail(
      `${where} holds a private key. Clawboo needs only ${holder}'s public key; ` +
        `keep the private key with ${holder}, and replace it if others could read this setting.`,
    )
  }
  if (text.startsWith('{')) {
    let doc: unknown
    try {
      doc = JSON.parse(text)
    } catch {
      fail(`${where} is not valid JSON.`)
    }
    const set = doc as { keys?: unknown }
    const list = Array.isArray(set?.keys) ? set.keys : [doc]
    if (list.length === 0 || list.length > 16) fail(`${where} must hold from 1 to 16 keys.`)
    return {
      keys: list.map((k, i) =>
        checkJwk(k, list.length > 1 ? `${where} key ${i + 1}` : where, holder),
      ),
    }
  }
  if (/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(text)) {
    let jwk: webcrypto.JsonWebKey
    try {
      jwk = createPublicKey({ key: text, format: 'pem' }).export({ format: 'jwk' })
    } catch {
      fail(`${where} is not a public key Clawboo can read.`)
    }
    return { keys: [checkJwk(jwk, where, holder)] }
  }
  fail(`${where} must be a PEM public key (BEGIN PUBLIC KEY), a JWK or a JWKS.`)
}

function isLoopbackHostname(hostname: string): boolean {
  const h = hostname.toLowerCase()
  return h === 'localhost' || h === '127.0.0.1' || h === '[::1]' || h === '::1'
}

function textSetting(key: OperatorKey): string | null {
  const value = effectiveSetting(key).value
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null
}

/**
 * The lane's settings, or null when it is off. Throws OperatorSettingsError on
 * a lane that is on but incomplete or untrustworthy.
 */
export function loadProxyIdentityConfig(): ProxyIdentityConfig | null {
  const mode = effectiveSetting('proxyIdentity').value as ProxyIdentityMode
  if (mode === 'off') return null

  const lane = 'The proxy identity lane'
  const header = (textSetting('proxyIdentityHeader') ?? 'clawboo-identity').toLowerCase()
  if (!HEADER_NAME.test(header) || RESERVED_HEADERS.has(header)) {
    fail(`proxyIdentityHeader must be a header name of your own, such as clawboo-identity.`)
  }

  const issuer = textSetting('proxyIdentityIssuer')
  const audience = textSetting('proxyIdentityAudience')
  // Without both, a token any app's sign-in provider signed for anyone would do.
  if (!issuer || !audience) {
    fail(
      `${lane} is ${mode} but proxyIdentityIssuer and proxyIdentityAudience are not both set. ` +
        "Set them to the iss and aud your proxy's tokens carry.",
    )
  }

  const jwksUrl = textSetting('proxyIdentityJwksUrl')
  const publicKey = textSetting('proxyIdentityPublicKey')
  if (jwksUrl && publicKey) {
    fail(`${lane} has both proxyIdentityJwksUrl and proxyIdentityPublicKey. Set only one.`)
  }
  let keys: ProxyIdentityKeys
  if (jwksUrl) {
    const url = new URL(jwksUrl)
    // Over plain http anyone on the path could hand Clawboo their own keys.
    if (url.protocol !== 'https:' && !isLoopbackHostname(url.hostname)) {
      fail('proxyIdentityJwksUrl must be an https URL (plain http only to this computer).')
    }
    keys = { source: 'jwks-url', url }
  } else if (publicKey) {
    keys = {
      source: 'public-key',
      jwks: parsePublicKeySetting(publicKey, 'proxyIdentityPublicKey'),
    }
  } else {
    fail(
      `${lane} is ${mode} but has no key. Set proxyIdentityJwksUrl or proxyIdentityPublicKey ` +
        "to your proxy's public key.",
    )
  }

  const nameClaim = textSetting('proxyIdentityNameClaim') ?? 'name'
  const roleClaim = textSetting('proxyIdentityRoleClaim') ?? 'role'
  for (const [key, value] of [
    ['proxyIdentityNameClaim', nameClaim],
    ['proxyIdentityRoleClaim', roleClaim],
  ] as const) {
    if (!CLAIM_PATH.test(value)) fail(`${key} must be a claim name such as name or role.`)
  }

  return {
    mode,
    header,
    issuer,
    audience,
    binding: effectiveSetting('proxyIdentityBinding').value as ProxyIdentityBinding,
    maxLifetimeSeconds: effectiveSetting('proxyIdentityMaxLifetime').value as number,
    nameClaim,
    roleClaim,
    keys,
    accountSubjects: 'any',
  }
}

/**
 * The issuers the lane trusts, in order: the sign-in proxy's, then the app
 * link's. With both on, the proxy may not name an `account:` person, so the two
 * id spaces cannot meet. A proxy on its own keeps whatever ids it already used.
 */
export function identityConfigs(
  proxy: ProxyIdentityConfig | null,
  appLink: ProxyIdentityConfig | null,
): ProxyIdentityConfig[] {
  if (!proxy) return appLink ? [appLink] : []
  if (!appLink) return [proxy]
  // Only a clash when both are on: a proxy on its own may use any header name.
  if (proxy.header === appLink.header) {
    fail(
      `proxyIdentityHeader is ${APP_LINK_HEADER}, the header the app that started Clawboo ` +
        'signs its requests in. Give your sign-in proxy a header of its own.',
    )
  }
  return [{ ...proxy, accountSubjects: 'never' }, appLink]
}

/** Whether the app that started this engine handed it an app link key. */
export function appLinkOn(env: NodeJS.ProcessEnv = process.env): boolean {
  return (env[APP_LINK_KEY_ENV]?.trim() ?? '') !== ''
}

/**
 * The app link's settings, or null when the app that started this engine gave
 * it no key. Read from `env` only, never from the operator file (see the top of
 * this file). Throws OperatorSettingsError on a key it cannot trust, so the
 * engine does not start with a link the app believes is on.
 *
 * What it trusts is fixed: Ed25519 only, request-bound tokens of at most 60
 * seconds, and `account:` people only. An app link's tokens never make a
 * request required to carry one; the dashboard keeps working without.
 */
export function loadAppLinkConfig(
  env: NodeJS.ProcessEnv = process.env,
): ProxyIdentityConfig | null {
  const raw = env[APP_LINK_KEY_ENV]?.trim()
  if (!raw) return null
  const jwks = parsePublicKeySetting(raw, APP_LINK_KEY_ENV, 'the app')
  if (jwks.keys.some((k) => k.kty !== 'OKP')) {
    fail(`${APP_LINK_KEY_ENV} must be an Ed25519 public key.`)
  }
  return {
    mode: 'on',
    header: APP_LINK_HEADER,
    issuer: APP_LINK_ISSUER,
    audience: APP_LINK_AUDIENCE,
    binding: 'request',
    maxLifetimeSeconds: 60,
    nameClaim: 'name',
    roleClaim: 'role',
    keys: { source: 'public-key', jwks },
    accountSubjects: 'only',
    routes: APP_LINK_ROUTES,
  }
}

/** The lane's mode as the operator set it, without checking the rest. */
export function proxyIdentityMode(): ProxyIdentityMode {
  return effectiveSetting('proxyIdentity').value as ProxyIdentityMode
}

function writableByUs(target: string): boolean {
  try {
    fs.accessSync(target, fs.constants.W_OK)
    return true
  } catch {
    return false
  }
}

/** What `replaceableBy` asks of the filesystem: `stat` is an lstat. */
export interface PathProbe {
  stat: (p: string) => { uid: number; mode: number }
  writable: (p: string) => boolean
}

const STICKY = 0o1000

/**
 * Whether the user `uid` can change `file` or put another file in its place:
 * it can write the file; it owns the file or any folder above it (an owner can
 * always make it writable again); or it can write a folder above it, which lets
 * it rename the folder below and make its own. A sticky folder such as `/tmp`
 * lets a user rename only what it owns there, so it counts only then.
 */
export function replaceableBy(file: string, uid: number, probe: PathProbe): boolean {
  const chain: string[] = []
  for (let p = path.resolve(file); ; p = path.dirname(p)) {
    chain.push(p)
    if (path.dirname(p) === p) break
  }
  const stat = (p: string) => {
    try {
      return probe.stat(p)
    } catch {
      return null
    }
  }
  if (probe.writable(chain[0]!)) return true
  for (let i = 0; i < chain.length; i++) {
    const here = stat(chain[i]!)
    if (!here) continue
    if (here.uid === uid) return true
    if (i === 0 || !probe.writable(chain[i]!)) continue
    if ((here.mode & STICKY) === 0) return true
    if (stat(chain[i - 1]!)?.uid === uid) return true
  }
  return false
}

/** `replaceableBy` for this process, on the real filesystem. */
function replaceableByUs(file: string, uid: number): boolean {
  const probe: PathProbe = { stat: (p) => fs.lstatSync(p), writable: writableByUs }
  let real = file
  try {
    real = fs.realpathSync(file)
  } catch {
    // Judged by the path as named.
  }
  return replaceableBy(file, uid, probe) || (real !== file && replaceableBy(real, uid, probe))
}

/**
 * Whether this server's own OS user can change or replace the operator file
 * (see replaceableBy), or null on Windows, where Node cannot tell.
 */
export function operatorFileReplaceable(
  { uid }: { uid: number | undefined } = { uid: process.getuid?.() },
): boolean | null {
  if (uid === undefined) return null
  return replaceableByUs(operatorFileLocation().path, uid)
}

/**
 * A warning when the lane's settings come from an operator file that this
 * server's own OS user can change, or replace through a folder above it (see
 * replaceableBy). Agents run as that user, so one could put its own key there
 * and sign in as anyone after the next restart. Null when nothing is read from
 * such a file.
 *
 * On Windows (`uid` undefined) it cannot tell: Node reads neither owners nor ACLs
 * there, and its writable check sees only the read-only flag, which the file's
 * owner can clear. So it warns whenever the settings come from the file, and
 * says it could not check.
 */
export function proxyIdentityFileWarning(
  { uid }: { uid: number | undefined } = { uid: process.getuid?.() },
): string | null {
  const keys = (Object.keys(OPERATOR_KEYS) as OperatorKey[]).filter((k) =>
    k.startsWith('proxyIdentity'),
  )
  if (!keys.some((k) => effectiveSetting(k).source === 'file')) return null
  const file = operatorFileLocation().path
  if (uid === undefined) {
    return (
      `SECURITY: the proxy identity settings come from ${file}. Clawboo cannot check on ` +
      "Windows who can change that file: if this server's own user can, so can every agent " +
      'it runs. Let only administrators change the file and its folders, or set the ' +
      "CLAWBOO_PROXY_IDENTITY variables in the service's environment instead."
    )
  }
  if (!replaceableByUs(file, uid)) return null
  return (
    `SECURITY: the proxy identity settings come from ${file}, which this server's own user ` +
    'can change or replace, and so can every agent it runs. Keep the file, and every folder ' +
    'above it, owned by another user such as root and not writable by this one, or set the ' +
    'CLAWBOO_PROXY_IDENTITY variables in your service manager instead.'
  )
}
