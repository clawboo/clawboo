/**
 * Server-side Ed25519 device identity for the gateway proxy.
 *
 * Mirrors the browser-side device-auth in @clawboo/gateway-client but uses
 * filesystem storage instead of localStorage and works in Node.js.
 *
 * The proxy signs connect frames with its own device identity so that:
 *   - Browsers don't need to manage device keys
 *   - The Gateway receives a valid device signature on every connect
 *   - Fresh browser contexts (preview, incognito) work out of the box
 */

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { createHash } from 'node:crypto'
import { getPublicKeyAsync, signAsync, utils } from '@noble/ed25519'

// ─── Base64url encoding ─────────────────────────────────────────────────────

function base64UrlEncode(bytes: Uint8Array): string {
  const buf = Buffer.from(bytes)
  return buf.toString('base64url')
}

function base64UrlDecode(input: string): Uint8Array {
  return new Uint8Array(Buffer.from(input, 'base64url'))
}

function bytesToHex(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('hex')
}

// ─── Device identity ────────────────────────────────────────────────────────

type StoredIdentity = {
  version: 1
  deviceId: string
  publicKey: string
  privateKey: string
  createdAtMs: number
}

export type DeviceIdentity = {
  deviceId: string
  publicKey: string
  privateKey: string
}

function fingerprintPublicKey(publicKey: Uint8Array): string {
  const hash = createHash('sha256').update(publicKey).digest()
  return bytesToHex(new Uint8Array(hash))
}

async function generateIdentity(): Promise<DeviceIdentity> {
  const privateKey = utils.randomPrivateKey()
  const publicKey = await getPublicKeyAsync(privateKey)
  const deviceId = fingerprintPublicKey(publicKey)
  return {
    deviceId,
    publicKey: base64UrlEncode(publicKey),
    privateKey: base64UrlEncode(privateKey),
  }
}

function getIdentityPath(): string {
  return join(homedir(), '.openclaw', 'clawboo', 'proxy-device-identity.json')
}

/**
 * Load device identity from disk, or generate and persist a new one.
 */
export async function loadOrCreateProxyDeviceIdentity(): Promise<DeviceIdentity> {
  const path = getIdentityPath()

  // Try to load existing identity
  try {
    const raw = readFileSync(path, 'utf-8')
    const parsed = JSON.parse(raw) as StoredIdentity
    if (
      parsed?.version === 1 &&
      typeof parsed.deviceId === 'string' &&
      typeof parsed.publicKey === 'string' &&
      typeof parsed.privateKey === 'string'
    ) {
      // Verify device ID matches public key fingerprint
      const derivedId = fingerprintPublicKey(base64UrlDecode(parsed.publicKey))
      return {
        deviceId: derivedId,
        publicKey: parsed.publicKey,
        privateKey: parsed.privateKey,
      }
    }
  } catch {
    // File doesn't exist or is invalid — generate new identity
  }

  const identity = await generateIdentity()
  const stored: StoredIdentity = {
    version: 1,
    deviceId: identity.deviceId,
    publicKey: identity.publicKey,
    privateKey: identity.privateKey,
    createdAtMs: Date.now(),
  }

  // Ensure directory exists
  try {
    mkdirSync(join(homedir(), '.openclaw', 'clawboo'), { recursive: true })
    writeFileSync(path, JSON.stringify(stored, null, 2), 'utf-8')
  } catch {
    // Non-fatal — identity works for this session even if not persisted
  }

  return identity
}

// ─── Signing ────────────────────────────────────────────────────────────────

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

// ─── Public API ─────────────────────────────────────────────────────────────

export type ProxyDeviceFields = {
  device: {
    id: string
    publicKey: string
    signature: string
    signedAt: number
    nonce?: string
  }
}

/**
 * Sign a connect frame's params with the proxy's device identity.
 *
 * Extracts the relevant fields from the connect params (client.id, client.mode,
 * role, scopes, auth.token) and signs them with the proxy's Ed25519 key.
 */
export async function signConnectParams(
  identity: DeviceIdentity,
  params: Record<string, unknown>,
  nonce: string | null,
): Promise<ProxyDeviceFields> {
  const client = (params['client'] ?? {}) as Record<string, unknown>
  const auth = (params['auth'] ?? {}) as Record<string, unknown>
  const scopes = Array.isArray(params['scopes']) ? (params['scopes'] as string[]) : []
  const role = typeof params['role'] === 'string' ? params['role'] : 'operator'
  const clientId = typeof client['id'] === 'string' ? client['id'] : 'openclaw-control-ui'
  const clientMode = typeof client['mode'] === 'string' ? client['mode'] : 'webchat'
  const token = typeof auth['token'] === 'string' ? auth['token'] : undefined

  const signedAtMs = Date.now()
  const payload = buildDeviceAuthPayload({
    deviceId: identity.deviceId,
    clientId,
    clientMode,
    role,
    scopes,
    signedAtMs,
    token,
    nonce,
  })
  const signature = await signDevicePayload(identity.privateKey, payload)

  return {
    device: {
      id: identity.deviceId,
      publicKey: identity.publicKey,
      signature,
      signedAt: signedAtMs,
      ...(nonce ? { nonce } : {}),
    },
  }
}
