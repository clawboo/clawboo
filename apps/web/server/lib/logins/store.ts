// Saved website logins, in clawboo's encrypted vault under their own namespace.
//
// One vault slot per login, `website-login:<random id>`, holding the whole login
// as JSON: the site's origin, the username, the password, an optional one-time-
// code secret, an optional label, and the person it belongs to. The vault lends
// the password and the one-time-code secret to the storage scrub by their field
// names (see `secretMaterialOf` in secretsVault.ts), so a stored string that
// quotes one is masked wherever it lands.
//
// A VALUE NEVER LEAVES THIS MODULE except to the fill (`loginSecretFor`), which
// sends it into the agent's own browser and nowhere else. What the REST routes
// get is `SavedLoginMeta`: where, whose, whether a username and a one-time code
// are set. Nothing reads a username, password or code back to a browser.
//
// A login belongs to a person. A run fills only its own person's logins (see
// runPerson.ts). On an install with one person, that person is the built-in
// local person and owns every login.

import { randomBytes } from 'node:crypto'

import {
  deleteRuntimeSecret,
  getRuntimeSecret,
  setRuntimeSecret,
  vaultSlotNames,
} from '../secretsVault'
import { loginOriginOf } from './origin'

const SLOT_PREFIX = 'website-login:'

/** Bounds on what a person may store, so a slot stays a login and not a file. */
export const LOGIN_LIMITS = {
  username: 512,
  password: 1_024,
  oneTimeCodeSecret: 256,
  label: 120,
} as const

interface StoredLogin {
  v: 1
  origin: string
  username: string
  password: string
  /** Base32, as sites show it next to their QR code. */
  otpSecret?: string
  label?: string
  ownerId: string
  createdAt: number
  updatedAt: number
}

/** What a caller outside the fill may know about a login. Never a value. */
export interface SavedLoginMeta {
  id: string
  origin: string
  label: string | null
  ownerId: string
  hasUsername: boolean
  hasOneTimeCode: boolean
  createdAt: number
  updatedAt: number
}

/** What the fill sends into the page. Only `fill.ts` holds one. */
export interface LoginSecret {
  username: string
  password: string
  otpSecret: string | null
}

export type LoginWriteError =
  | 'invalid_site'
  | 'insecure_site'
  | 'missing_password'
  | 'too_long'
  | 'invalid_one_time_code'
  | 'exists'
  | 'not_found'

const slotOf = (id: string): string => `${SLOT_PREFIX}${id}`

function parseStored(raw: string | null): StoredLogin | null {
  if (!raw) return null
  try {
    const doc = JSON.parse(raw) as Partial<StoredLogin> | null
    if (
      !doc ||
      doc.v !== 1 ||
      typeof doc.origin !== 'string' ||
      typeof doc.username !== 'string' ||
      typeof doc.password !== 'string' ||
      typeof doc.ownerId !== 'string'
    ) {
      return null
    }
    return {
      v: 1,
      origin: doc.origin,
      username: doc.username,
      password: doc.password,
      ...(typeof doc.otpSecret === 'string' && doc.otpSecret ? { otpSecret: doc.otpSecret } : {}),
      ...(typeof doc.label === 'string' && doc.label ? { label: doc.label } : {}),
      ownerId: doc.ownerId,
      createdAt: typeof doc.createdAt === 'number' ? doc.createdAt : 0,
      updatedAt: typeof doc.updatedAt === 'number' ? doc.updatedAt : 0,
    }
  } catch {
    return null
  }
}

function metaOf(id: string, login: StoredLogin): SavedLoginMeta {
  return {
    id,
    origin: login.origin,
    label: login.label ?? null,
    ownerId: login.ownerId,
    hasUsername: login.username.length > 0,
    hasOneTimeCode: Boolean(login.otpSecret),
    createdAt: login.createdAt,
    updatedAt: login.updatedAt,
  }
}

function allLogins(): { id: string; login: StoredLogin }[] {
  const out: { id: string; login: StoredLogin }[] = []
  for (const slot of vaultSlotNames(SLOT_PREFIX)) {
    const login = parseStored(getRuntimeSecret(slot))
    if (login) out.push({ id: slot.slice(SLOT_PREFIX.length), login })
  }
  return out
}

/** A base32 one-time-code secret as sites print it, normalized, or null when it is not one. */
export function normalizeOtpSecret(input: string): string | null {
  const s = input.replace(/[\s-]/g, '').replace(/=+$/, '').toUpperCase()
  if (s.length < 16 || s.length > LOGIN_LIMITS.oneTimeCodeSecret) return null
  return /^[A-Z2-7]+$/.test(s) ? s : null
}

function originOrError(site: string): { origin: string } | { error: LoginWriteError } {
  const r = loginOriginOf(site)
  if (r.ok) return { origin: r.origin }
  return { error: r.reason === 'insecure' ? 'insecure_site' : 'invalid_site' }
}

/** Every login a person owns, newest change first. Metadata only. */
export function listSavedLogins(ownerId: string): SavedLoginMeta[] {
  return allLogins()
    .filter(({ login }) => login.ownerId === ownerId)
    .map(({ id, login }) => metaOf(id, login))
    .sort((a, b) => b.updatedAt - a.updatedAt)
}

export interface NewLoginInput {
  site: string
  username?: string | null
  password: string
  oneTimeCodeSecret?: string | null
  label?: string | null
  ownerId: string
}

/** Save a login. One per site and person: a second for the same site is `exists`. */
export function addSavedLogin(
  input: NewLoginInput,
): { ok: true; login: SavedLoginMeta } | { ok: false; error: LoginWriteError } {
  const site = originOrError(input.site)
  if ('error' in site) return { ok: false, error: site.error }
  const username = (input.username ?? '').trim()
  const password = input.password
  if (!password) return { ok: false, error: 'missing_password' }
  const label = (input.label ?? '').trim()
  if (
    username.length > LOGIN_LIMITS.username ||
    password.length > LOGIN_LIMITS.password ||
    label.length > LOGIN_LIMITS.label
  ) {
    return { ok: false, error: 'too_long' }
  }
  let otpSecret: string | null = null
  if (input.oneTimeCodeSecret && input.oneTimeCodeSecret.trim()) {
    otpSecret = normalizeOtpSecret(input.oneTimeCodeSecret)
    if (!otpSecret) return { ok: false, error: 'invalid_one_time_code' }
  }
  if (
    allLogins().some(({ login }) => login.ownerId === input.ownerId && login.origin === site.origin)
  ) {
    return { ok: false, error: 'exists' }
  }
  const now = Date.now()
  const id = randomBytes(12).toString('base64url')
  const stored: StoredLogin = {
    v: 1,
    origin: site.origin,
    username,
    password,
    ...(otpSecret ? { otpSecret } : {}),
    ...(label ? { label } : {}),
    ownerId: input.ownerId,
    createdAt: now,
    updatedAt: now,
  }
  setRuntimeSecret(slotOf(id), JSON.stringify(stored))
  return { ok: true, login: metaOf(id, stored) }
}

export interface LoginPatch {
  site?: string
  /** A new username; an empty string clears it. Absent keeps it. */
  username?: string
  /** A new password. Absent or empty keeps it. */
  password?: string
  /** A new one-time-code secret; null removes it. Absent keeps it. */
  oneTimeCodeSecret?: string | null
  /** A new label; an empty string clears it. Absent keeps it. */
  label?: string
}

/** Change a login its owner holds. Fields left out keep their value. */
export function updateSavedLogin(
  id: string,
  ownerId: string,
  patch: LoginPatch,
): { ok: true; login: SavedLoginMeta } | { ok: false; error: LoginWriteError } {
  const current = parseStored(getRuntimeSecret(slotOf(id)))
  if (!current || current.ownerId !== ownerId) return { ok: false, error: 'not_found' }
  const next: StoredLogin = { ...current }
  if (patch.site !== undefined) {
    const site = originOrError(patch.site)
    if ('error' in site) return { ok: false, error: site.error }
    if (
      site.origin !== current.origin &&
      allLogins().some(
        ({ id: other, login }) =>
          other !== id && login.ownerId === ownerId && login.origin === site.origin,
      )
    ) {
      return { ok: false, error: 'exists' }
    }
    next.origin = site.origin
  }
  if (patch.username !== undefined) {
    const username = patch.username.trim()
    if (username.length > LOGIN_LIMITS.username) return { ok: false, error: 'too_long' }
    next.username = username
  }
  if (patch.password) {
    if (patch.password.length > LOGIN_LIMITS.password) return { ok: false, error: 'too_long' }
    next.password = patch.password
  }
  if (patch.oneTimeCodeSecret === null || patch.oneTimeCodeSecret === '') {
    delete next.otpSecret
  } else if (patch.oneTimeCodeSecret !== undefined) {
    const otp = normalizeOtpSecret(patch.oneTimeCodeSecret)
    if (!otp) return { ok: false, error: 'invalid_one_time_code' }
    next.otpSecret = otp
  }
  if (patch.label !== undefined) {
    const label = patch.label.trim()
    if (label.length > LOGIN_LIMITS.label) return { ok: false, error: 'too_long' }
    if (label) next.label = label
    else delete next.label
  }
  next.updatedAt = Date.now()
  setRuntimeSecret(slotOf(id), JSON.stringify(next))
  return { ok: true, login: metaOf(id, next) }
}

/** Remove a login its owner holds. False when there is none. */
export function removeSavedLogin(id: string, ownerId: string): boolean {
  const current = parseStored(getRuntimeSecret(slotOf(id)))
  if (!current || current.ownerId !== ownerId) return false
  deleteRuntimeSecret(slotOf(id))
  return true
}

/**
 * The login a person saved for exactly this origin, for the fill alone. Null when
 * there is none.
 */
export function loginSecretFor(origin: string, ownerId: string): LoginSecret | null {
  for (const { login } of allLogins()) {
    if (login.ownerId === ownerId && login.origin === origin) {
      return {
        username: login.username,
        password: login.password,
        otpSecret: login.otpSecret ?? null,
      }
    }
  }
  return null
}
