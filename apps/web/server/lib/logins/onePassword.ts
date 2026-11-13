// 1Password as a source of website logins, through the official SDK
// (`@1password/sdk`, MIT) and a service account token.
//
// The token is a person's: it lives in clawboo's vault, under its own slot,
// with the person it belongs to, and a run reaches the items it can read only
// when the run is that person's (runPerson.ts). It never leaves the server: not
// to a browser, not to an agent process, not to a log.
//
// Items are found by site: a Login item one of whose website addresses has exactly
// the page's origin (the same rule as a saved login; see origin.ts), and whose
// autofill setting is not "Never". The SDK is installed on first use into the
// runtimes folder and loaded only when someone connects or a fill needs it, never
// at boot; tests replace it with a fake client.

import { randomBytes } from 'node:crypto'

import { createLogger } from '@clawboo/logger'

import {
  deleteRuntimeSecret,
  getRuntimeSecret,
  setRuntimeSecret,
  vaultSlotNames,
} from '../secretsVault'
import { loadOnePasswordSdk } from './onePasswordSdk'
import { loginOriginOf } from './origin'
import { totpCode } from './totp'

const log = createLogger('website-logins-1password')

const SLOT_PREFIX = 'website-login-source:1password:'
/** A vault with more Login items than this is searched no further: a fill must not
 *  hang on a huge account. Service accounts are scoped to the vaults they need. */
const MAX_ITEMS_SEARCHED = 2_000
const MAX_TOKEN_LENGTH = 8_192

/** The part of the SDK the source uses, so a fake can stand in for it. */
export interface OnePasswordClient {
  listVaultIds(): Promise<string[]>
  /** Login items in a vault, with their website addresses. */
  listLoginItems(vaultId: string): Promise<OnePasswordItemOverview[]>
  getItem(vaultId: string, itemId: string): Promise<OnePasswordItem>
}

export interface OnePasswordItemOverview {
  id: string
  vaultId: string
  websites: { url: string; autofillBehavior?: string }[]
}

export interface OnePasswordItem {
  fields: {
    id: string
    title?: string
    fieldType: string
    value: string
    details?: unknown
  }[]
}

export type OnePasswordClientFactory = (token: string) => Promise<OnePasswordClient>

/** The values for one fill. Only fill.ts holds one. */
export interface OnePasswordLogin {
  username: string
  password: string
  oneTimeCode: string | null
}

export type OnePasswordError = 'unreachable' | 'rejected' | 'sdk_missing'

class SdkMissingError extends Error {
  constructor() {
    super('the 1Password SDK is not installed')
    this.name = 'SdkMissingError'
  }
}

// ─── The SDK adapter ─────────────────────────────────────────────────────────

/** Collect an array, or an async iterable as older SDK releases return. */
async function collect<T>(v: unknown): Promise<T[]> {
  if (Array.isArray(v)) return v as T[]
  const out: T[] = []
  if (v && typeof (v as AsyncIterable<T>)[Symbol.asyncIterator] === 'function') {
    for await (const item of v as AsyncIterable<T>) out.push(item)
  }
  return out
}

interface SdkLike {
  createClient(config: {
    auth: string
    integrationName: string
    integrationVersion: string
  }): Promise<{
    vaults: { list?: () => Promise<unknown>; listAll?: () => Promise<unknown> }
    items: {
      list?: (vaultId: string) => Promise<unknown>
      listAll?: (vaultId: string) => Promise<unknown>
      get: (vaultId: string, itemId: string) => Promise<unknown>
    }
  }>
}

const sdkFactory: OnePasswordClientFactory = async (token) => {
  // The copy installed into the runtimes folder on first use (onePasswordSdk.ts).
  // Never a dependency: it is not in the server bundle and nothing else loads it.
  let sdk: SdkLike
  try {
    const loaded = (await loadOnePasswordSdk()) as SdkLike | null
    if (!loaded) throw new SdkMissingError()
    sdk = loaded
  } catch {
    throw new SdkMissingError()
  }
  const client = await sdk.createClient({
    auth: token,
    integrationName: 'Clawboo website logins',
    integrationVersion: 'v1',
  })
  return {
    listVaultIds: async () => {
      const raw = client.vaults.list ? await client.vaults.list() : await client.vaults.listAll?.()
      return (await collect<{ id?: unknown }>(raw))
        .map((v) => v.id)
        .filter((id): id is string => typeof id === 'string')
    },
    listLoginItems: async (vaultId) => {
      const raw = client.items.list
        ? await client.items.list(vaultId)
        : await client.items.listAll?.(vaultId)
      const overviews = await collect<Record<string, unknown>>(raw)
      return overviews
        .filter((o) => o['category'] === 'Login' && typeof o['id'] === 'string')
        .map((o) => ({
          id: o['id'] as string,
          vaultId,
          websites: Array.isArray(o['websites'])
            ? (o['websites'] as Record<string, unknown>[])
                .filter((w) => typeof w['url'] === 'string')
                .map((w) => ({
                  url: w['url'] as string,
                  ...(typeof w['autofillBehavior'] === 'string'
                    ? { autofillBehavior: w['autofillBehavior'] }
                    : {}),
                }))
            : [],
        }))
    },
    getItem: async (vaultId, itemId) => {
      const item = (await client.items.get(vaultId, itemId)) as { fields?: unknown }
      const fields = Array.isArray(item?.fields) ? (item.fields as Record<string, unknown>[]) : []
      return {
        fields: fields.map((f) => ({
          id: typeof f['id'] === 'string' ? f['id'] : '',
          ...(typeof f['title'] === 'string' ? { title: f['title'] } : {}),
          fieldType: typeof f['fieldType'] === 'string' ? f['fieldType'] : '',
          value: typeof f['value'] === 'string' ? f['value'] : '',
          ...(f['details'] !== undefined ? { details: f['details'] } : {}),
        })),
      }
    },
  }
}

let factory: OnePasswordClientFactory = sdkFactory

/** Replace the client (tests), or with null restore the SDK. */
export function setOnePasswordClientFactory(next: OnePasswordClientFactory | null): void {
  factory = next ?? sdkFactory
}

function errorCodeOf(err: unknown): OnePasswordError {
  if (err instanceof SdkMissingError) return 'sdk_missing'
  // The SDK reports a bad or revoked token with a message about authentication.
  // Only the class is kept: the message is never logged or returned.
  // A network failure is read first: its message can name anything, a token included.
  const text = err instanceof Error ? err.message : ''
  if (
    /ETIMEDOUT|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|network|fetch failed|socket/i.test(text)
  )
    return 'unreachable'
  return /auth|token|unauthori[sz]ed|forbidden|invalid service account/i.test(text)
    ? 'rejected'
    : 'unreachable'
}

// ─── The connection, in the vault ─────────────────────────────────────────────

interface StoredConnection {
  v: 1
  token: string
  ownerId: string
  connectedAt: number
}

function parseConnection(raw: string | null): StoredConnection | null {
  if (!raw) return null
  try {
    const doc = JSON.parse(raw) as Partial<StoredConnection> | null
    if (!doc || doc.v !== 1 || typeof doc.token !== 'string' || typeof doc.ownerId !== 'string') {
      return null
    }
    return {
      v: 1,
      token: doc.token,
      ownerId: doc.ownerId,
      connectedAt: typeof doc.connectedAt === 'number' ? doc.connectedAt : 0,
    }
  } catch {
    return null
  }
}

function connectionOf(ownerId: string): { slot: string; conn: StoredConnection } | null {
  for (const slot of vaultSlotNames(SLOT_PREFIX)) {
    const conn = parseConnection(getRuntimeSecret(slot))
    if (conn && conn.ownerId === ownerId) return { slot, conn }
  }
  return null
}

/** Whether this person has 1Password connected. Never the token. */
export function onePasswordStatus(ownerId: string): {
  connected: boolean
  connectedAt: number | null
} {
  const found = connectionOf(ownerId)
  return { connected: found !== null, connectedAt: found?.conn.connectedAt ?? null }
}

/**
 * Connect a person's 1Password with a service account token. The token is checked
 * (it must list at least one vault) before it is saved, and replaces the person's
 * earlier one. Answers how many vaults it can read, never their names.
 */
export async function connectOnePassword(
  ownerId: string,
  token: string,
): Promise<
  { ok: true; vaults: number } | { ok: false; error: OnePasswordError | 'invalid_token' }
> {
  const t = token.trim()
  if (!t || t.length > MAX_TOKEN_LENGTH || /\s/.test(t))
    return { ok: false, error: 'invalid_token' }
  let vaults: number
  try {
    const client = await factory(t)
    vaults = (await client.listVaultIds()).length
  } catch (err) {
    const code = errorCodeOf(err)
    log.warn({ error: code }, 'could not connect 1Password')
    return { ok: false, error: code }
  }
  if (vaults === 0) return { ok: false, error: 'rejected' }
  const existing = connectionOf(ownerId)
  const slot = existing?.slot ?? `${SLOT_PREFIX}${randomBytes(12).toString('base64url')}`
  const stored: StoredConnection = { v: 1, token: t, ownerId, connectedAt: Date.now() }
  setRuntimeSecret(slot, JSON.stringify(stored))
  return { ok: true, vaults }
}

/** Forget a person's 1Password token. False when none was saved. */
export function disconnectOnePassword(ownerId: string): boolean {
  const found = connectionOf(ownerId)
  if (!found) return false
  deleteRuntimeSecret(found.slot)
  return true
}

function websiteMatches(w: { url: string; autofillBehavior?: string }, origin: string): boolean {
  if (w.autofillBehavior === 'Never') return false
  const r = loginOriginOf(w.url)
  return r.ok && r.origin === origin
}

/** The current code from a TOTP field: the SDK's computed code, else from its secret. */
function oneTimeCodeOf(field: OnePasswordItem['fields'][number]): string | null {
  const details = field.details as { content?: { code?: unknown } } | undefined
  const code = details?.content?.code
  if (typeof code === 'string' && /^\d{6,8}$/.test(code)) return code
  const value = field.value.trim()
  if (!value) return null
  if (value.startsWith('otpauth://')) {
    try {
      const secret = new URL(value).searchParams.get('secret')
      return secret ? totpCode(secret) : null
    } catch {
      return null
    }
  }
  return totpCode(value)
}

function loginFromItem(item: OnePasswordItem): OnePasswordLogin | null {
  const byId = (id: string) => item.fields.find((f) => f.id === id && f.value)
  const password =
    byId('password') ??
    item.fields.find(
      (f) => f.fieldType === 'Concealed' && /password/i.test(f.title ?? '') && f.value,
    )
  if (!password) return null
  const username =
    byId('username') ??
    item.fields.find(
      (f) =>
        (f.fieldType === 'Text' || f.fieldType === 'Email') &&
        /user|e-?mail|login/i.test(f.title ?? '') &&
        f.value,
    )
  const totp = item.fields.find((f) => f.fieldType === 'Totp')
  return {
    username: username?.value ?? '',
    password: password.value,
    oneTimeCode: totp ? oneTimeCodeOf(totp) : null,
  }
}

export type OnePasswordLookup =
  | { kind: 'found'; login: OnePasswordLogin }
  | { kind: 'none' }
  | { kind: 'failed'; error: OnePasswordError }

/** Whether this person has a 1Password connection to look in. */
export function hasOnePassword(ownerId: string): boolean {
  return connectionOf(ownerId) !== null
}

/**
 * The login this person's 1Password holds for exactly `origin`, for the fill alone.
 * `none` when there is no connection or no matching item.
 */
export async function onePasswordLoginFor(
  origin: string,
  ownerId: string,
): Promise<OnePasswordLookup> {
  const found = connectionOf(ownerId)
  if (!found) return { kind: 'none' }
  try {
    const client = await factory(found.conn.token)
    let searched = 0
    for (const vaultId of await client.listVaultIds()) {
      for (const overview of await client.listLoginItems(vaultId)) {
        searched += 1
        if (searched > MAX_ITEMS_SEARCHED) return { kind: 'none' }
        if (!overview.websites.some((w) => websiteMatches(w, origin))) continue
        const login = loginFromItem(await client.getItem(overview.vaultId, overview.id))
        if (login) return { kind: 'found', login }
      }
    }
    return { kind: 'none' }
  } catch (err) {
    const code = errorCodeOf(err)
    log.warn({ error: code }, 'could not read 1Password for a login fill')
    return { kind: 'failed', error: code }
  }
}
