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
}

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

/** Check one JWK and return the members a verifier needs. Never echoes key material. */
function checkJwk(raw: unknown, where: string): JWK {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    fail(`${where} must be a JSON Web Key object.`)
  }
  const jwk = raw as Record<string, unknown>
  for (const member of PRIVATE_MEMBERS) {
    if (member in jwk) {
      fail(
        `${where} holds a private or shared key. Clawboo needs only the proxy's public key; ` +
          'keep the private key with the proxy.',
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
export function parsePublicKeySetting(raw: string, where: string): JSONWebKeySet {
  const text = raw.trim().replace(/\\n/g, '\n')
  if (/PRIVATE KEY/.test(text)) {
    fail(
      `${where} holds a private key. Clawboo needs only the proxy's public key; ` +
        'keep the private key with the proxy, and replace it if others could read this setting.',
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
      keys: list.map((k, i) => checkJwk(k, list.length > 1 ? `${where} key ${i + 1}` : where)),
    }
  }
  if (/^-----BEGIN PUBLIC KEY-----[\s\S]+-----END PUBLIC KEY-----$/.test(text)) {
    let jwk: webcrypto.JsonWebKey
    try {
      jwk = createPublicKey({ key: text, format: 'pem' }).export({ format: 'jwk' })
    } catch {
      fail(`${where} is not a public key Clawboo can read.`)
    }
    return { keys: [checkJwk(jwk, where)] }
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
function replaceableByUs(file: string): boolean {
  const uid = process.getuid?.()
  // No owners to compare on Windows: the file and its folder must not be writable.
  if (uid === undefined) return writableByUs(file) || writableByUs(path.dirname(file))
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
 * A warning when the lane's settings come from an operator file that this
 * server's own OS user can change, or replace through a folder above it (see
 * replaceableBy). Agents run as that user, so one could put its own key there
 * and sign in as anyone after the next restart. Null when nothing is read from
 * such a file.
 */
export function proxyIdentityFileWarning(): string | null {
  const keys = (Object.keys(OPERATOR_KEYS) as OperatorKey[]).filter((k) =>
    k.startsWith('proxyIdentity'),
  )
  if (!keys.some((k) => effectiveSetting(k).source === 'file')) return null
  const file = operatorFileLocation().path
  if (!replaceableByUs(file)) return null
  return (
    `SECURITY: the proxy identity settings come from ${file}, which this server's own user ` +
    'can change or replace, and so can every agent it runs. Keep the file, and every folder ' +
    'above it, owned by another user such as root and not writable by this one, or set the ' +
    'CLAWBOO_PROXY_IDENTITY variables in your service manager instead.'
  )
}
