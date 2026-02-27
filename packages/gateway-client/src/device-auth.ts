/**
 * Ed25519 device identity and authentication for direct gateway connections.
 *
 * This module is internal — not re-exported from the package barrel.
 * It is only activated when `disableDeviceAuth` is explicitly set to `false`
 * AND `crypto.subtle` is available (secure browser context).
 */

import { createLogger } from '@clawboo/logger'
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519'
import type { GatewayHelloOk } from './types'

const log = createLogger('gateway-client:device-auth')

// ─── UUID generation (avoids Node crypto import in browser) ───────────────────

function uuidFromBytes(bytes: Uint8Array): string {
  bytes[6] = (bytes[6]! & 0x0f) | 0x40 // version 4
  bytes[8] = (bytes[8]! & 0x3f) | 0x80 // variant 1

  let hex = ''
  for (let i = 0; i < bytes.length; i++) {
    hex += bytes[i]!.toString(16).padStart(2, '0')
  }

  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

let warnedWeakCrypto = false

function generateUUID(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID()
  }
  if (typeof crypto !== 'undefined' && typeof crypto.getRandomValues === 'function') {
    const bytes = new Uint8Array(16)
    crypto.getRandomValues(bytes)
    return uuidFromBytes(bytes)
  }
  // Weak fallback
  if (!warnedWeakCrypto) {
    warnedWeakCrypto = true
    log.warn('crypto API missing; falling back to weak randomness for UUID generation')
  }
  const bytes = new Uint8Array(16)
  const now = Date.now()
  for (let i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256)
  bytes[0]! ^= now & 0xff
  bytes[1]! ^= (now >>> 8) & 0xff
  bytes[2]! ^= (now >>> 16) & 0xff
  bytes[3]! ^= (now >>> 24) & 0xff
  return uuidFromBytes(bytes)
}

export { generateUUID }

// ─── Base64url encoding ──────────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/g, '')
}

function base64UrlDecode(input: string): Uint8Array {
  const normalized = input.replaceAll('-', '+').replaceAll('_', '/')
  const padded = normalized + '='.repeat((4 - (normalized.length % 4)) % 4)
  const binary = atob(padded)
  const out = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i)
  return out
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

// ─── Device identity ─────────────────────────────────────────────────────────

type StoredIdentity = {
  version: 1
  deviceId: string
  publicKey: string
  privateKey: string
  createdAtMs: number
}

type DeviceIdentity = {
  deviceId: string
  publicKey: string
  privateKey: string
}

const DEVICE_IDENTITY_STORAGE_KEY = 'openclaw-device-identity-v1'

async function fingerprintPublicKey(publicKey: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest('SHA-256', new Uint8Array(publicKey))
  return bytesToHex(new Uint8Array(hash))
}

async function generateIdentity(): Promise<DeviceIdentity> {
  const privateKey = utils.randomPrivateKey()
  const publicKey = await getPublicKeyAsync(privateKey)
  const deviceId = await fingerprintPublicKey(publicKey)
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  }
}

async function loadOrCreateDeviceIdentity(): Promise<DeviceIdentity> {
  try {
    const raw = localStorage.getItem(DEVICE_IDENTITY_STORAGE_KEY)
    if (raw) {
      const parsed = JSON.parse(raw) as StoredIdentity
      if (
        parsed?.version === 1 &&
        typeof parsed.deviceId === 'string' &&
        typeof parsed.publicKey === 'string' &&
        typeof parsed.privateKey === 'string'
      ) {
        const derivedId = await fingerprintPublicKey(base64UrlDecode(parsed.publicKey))
        if (derivedId !== parsed.deviceId) {
          const updated: StoredIdentity = { ...parsed, deviceId: derivedId }
          localStorage.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(updated))
          return { deviceId: derivedId, publicKey: parsed.publicKey, privateKey: parsed.privateKey }
        }
        return {
          deviceId: parsed.deviceId,
          publicKey: parsed.publicKey,
          privateKey: parsed.privateKey,
        }
      }
    }
  } catch {
    // fall through to regenerate
  }

  log.info('generating new Ed25519 device identity')
  const identity = await generateIdentity()
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAtMs: Date.now(),
  }
  localStorage.setItem(DEVICE_IDENTITY_STORAGE_KEY, JSON.stringify(stored))
  log.info({ deviceId: identity.deviceId }, 'device identity created and stored')
  return identity
}

// ─── Device auth payload & signing ───────────────────────────────────────────

function buildDeviceAuthPayload(params: {
  deviceId: string
  clientId: string
  clientMode: string
  role: string
  scopes: string[]
  signedAtMs: number
  token?: string | null
  nonce?: string | null
}): string {
  const version = params.nonce ? 'v2' : 'v1'
  const scopes = params.scopes.join(',')
  const token = params.token ?? ''
  const base = [
    version,
    params.deviceId,
    params.clientId,
    params.clientMode,
    params.role,
    scopes,
    String(params.signedAtMs),
    token,
  ]
  if (version === 'v2') {
    base.push(params.nonce ?? '')
  }
  return base.join('|')
}

async function signDevicePayload(privateKeyBase64Url: string, payload: string): Promise<string> {
  const key = base64UrlDecode(privateKeyBase64Url)
  const data = new TextEncoder().encode(payload)
  const sig = await signAsync(data, key)
  return base64UrlEncode(sig)
}

// ─── Device token storage ────────────────────────────────────────────────────

type DeviceAuthEntry = {
  token: string
  role: string
  scopes: string[]
  updatedAtMs: number
}

type DeviceAuthStore = {
  version: 1
  deviceId: string
  tokens: Record<string, DeviceAuthEntry>
}

const DEVICE_AUTH_STORAGE_KEY = 'openclaw.device.auth.v1'

function normalizeAuthScope(scope: string | undefined): string {
  const trimmed = scope?.trim()
  if (!trimmed) return 'default'
  return trimmed.toLowerCase()
}

function buildScopedTokenKey(scope: string, role: string): string {
  return `${scope}::${role}`
}

function normalizeRole(role: string): string {
  return role.trim()
}

function normalizeScopes(scopes: string[] | undefined): string[] {
  if (!Array.isArray(scopes)) return []
  const out = new Set<string>()
  for (const scope of scopes) {
    const trimmed = scope.trim()
    if (trimmed) out.add(trimmed)
  }
  return [...out].sort()
}

function readDeviceAuthStore(): DeviceAuthStore | null {
  try {
    const raw = localStorage.getItem(DEVICE_AUTH_STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as DeviceAuthStore
    if (!parsed || parsed.version !== 1) return null
    if (!parsed.deviceId || typeof parsed.deviceId !== 'string') return null
    if (!parsed.tokens || typeof parsed.tokens !== 'object') return null
    return parsed
  } catch {
    return null
  }
}

function writeDeviceAuthStore(store: DeviceAuthStore): void {
  try {
    localStorage.setItem(DEVICE_AUTH_STORAGE_KEY, JSON.stringify(store))
  } catch {
    // best-effort
  }
}

function loadDeviceAuthToken(params: {
  deviceId: string
  role: string
  scope: string
}): DeviceAuthEntry | null {
  const store = readDeviceAuthStore()
  if (!store || store.deviceId !== params.deviceId) return null
  const role = normalizeRole(params.role)
  const scope = normalizeAuthScope(params.scope)
  const key = buildScopedTokenKey(scope, role)
  const entry = store.tokens[key]
  if (!entry || typeof entry.token !== 'string') return null
  return entry
}

function storeDeviceAuthToken(params: {
  deviceId: string
  role: string
  scope: string
  token: string
  scopes?: string[]
}): void {
  const role = normalizeRole(params.role)
  const scope = normalizeAuthScope(params.scope)
  const key = buildScopedTokenKey(scope, role)
  const next: DeviceAuthStore = { version: 1, deviceId: params.deviceId, tokens: {} }
  const existing = readDeviceAuthStore()
  if (existing && existing.deviceId === params.deviceId) {
    next.tokens = { ...existing.tokens }
  }
  next.tokens[key] = {
    token: params.token,
    role,
    scopes: normalizeScopes(params.scopes),
    updatedAtMs: Date.now(),
  }
  writeDeviceAuthStore(next)
}

// ─── Public API (consumed by client.ts) ──────────────────────────────────────

export async function buildDeviceConnectFields(opts: {
  token?: string | null
  password?: string | null
  authScopeKey: string
  clientName: string
  clientMode: string
  role: string
  scopes: string[]
  nonce: string | null
}): Promise<{
  auth?: { token?: string; password?: string }
  device?: {
    id: string
    publicKey: string
    signature: string
    signedAt: number
    nonce?: string
  }
  deviceId: string
  canFallbackToShared: boolean
}> {
  log.debug({ scope: opts.authScopeKey }, 'building device connect fields')
  const deviceIdentity = await loadOrCreateDeviceIdentity()
  const authScope = normalizeAuthScope(opts.authScopeKey)

  // Prefer stored device token over provided token
  const storedToken = loadDeviceAuthToken({
    deviceId: deviceIdentity.deviceId,
    role: opts.role,
    scope: authScope,
  })?.token
  const authToken = storedToken ?? (opts.token || undefined)
  const canFallbackToShared = Boolean(storedToken && opts.token)
  if (storedToken) {
    log.debug({ deviceId: deviceIdentity.deviceId }, 'using stored device token')
  }

  const auth =
    authToken || opts.password
      ? { token: authToken, password: opts.password || undefined }
      : undefined

  // Sign device payload
  const signedAtMs = Date.now()
  const nonce = opts.nonce ?? undefined
  const payload = buildDeviceAuthPayload({
    deviceId: deviceIdentity.deviceId,
    clientId: opts.clientName,
    clientMode: opts.clientMode,
    role: opts.role,
    scopes: opts.scopes,
    signedAtMs,
    token: authToken ?? null,
    nonce,
  })
  const signature = await signDevicePayload(deviceIdentity.privateKey, payload)

  return {
    auth,
    device: {
      id: deviceIdentity.deviceId,
      publicKey: deviceIdentity.publicKey,
      signature,
      signedAt: signedAtMs,
      nonce,
    },
    deviceId: deviceIdentity.deviceId,
    canFallbackToShared,
  }
}

export function handleDeviceTokenFromHello(params: {
  hello: GatewayHelloOk
  deviceId: string
  role: string
  authScopeKey: string
}): void {
  const token = params.hello.auth?.deviceToken
  if (!token) return
  log.info({ deviceId: params.deviceId, role: params.role }, 'storing device token from hello')
  storeDeviceAuthToken({
    deviceId: params.deviceId,
    role: params.hello.auth?.role ?? params.role,
    scope: normalizeAuthScope(params.authScopeKey),
    token,
    scopes: params.hello.auth?.scopes ?? [],
  })
}

export function clearDeviceToken(params: {
  deviceId: string
  role: string
  authScopeKey: string
}): void {
  log.info({ deviceId: params.deviceId, role: params.role }, 'clearing device token')
  const store = readDeviceAuthStore()
  if (!store || store.deviceId !== params.deviceId) return
  const role = normalizeRole(params.role)
  const scope = normalizeAuthScope(params.authScopeKey)
  const key = buildScopedTokenKey(scope, role)
  const hasScoped = Boolean(store.tokens[key])
  const hasLegacy = Boolean(store.tokens[role])
  if (!hasScoped && !hasLegacy) return
  const next = { ...store, tokens: { ...store.tokens } }
  delete next.tokens[key]
  delete next.tokens[role]
  writeDeviceAuthStore(next)
}
