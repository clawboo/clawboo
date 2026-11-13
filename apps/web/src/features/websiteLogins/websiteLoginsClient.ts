// Typed access to the website login routes.
//
// A saved value goes in and never comes back: no response here carries one, and
// nothing in this file logs a request body or puts a value in a URL. A failure is
// reduced to a code from a fixed list, and the panel turns that code into words
// through `loginErrorMessage`. The server's own text (a rate limiter's sentence,
// an exception's message) is never shown.

import { apiFetch } from '@clawboo/control-client'

export interface WebsiteLogin {
  id: string
  origin: string
  label: string | null
  hasUsername: boolean
  hasOneTimeCode: boolean
  createdAt: number
  updatedAt: number
}

export interface OnePasswordStatus {
  connected: boolean
  connectedAt: number | null
  /** 1Password support is downloaded once, on the first Connect. */
  sdkInstalled: boolean
  /** That download is running now. */
  sdkInstalling: boolean
}

export interface WebsiteLoginsSnapshot {
  logins: WebsiteLogin[]
  onePassword: OnePasswordStatus
  /** Whether a browser connector is connected, so agents can be filled in. */
  fillAvailable: boolean
}

export interface NewLogin {
  site: string
  username?: string
  password: string
  oneTimeCodeSecret?: string
  label?: string
}

export interface LoginChange {
  site?: string
  /** An empty string clears the saved username. */
  username?: string
  /** Sent only when the person typed a new one. */
  password?: string
  /** `null` removes the one-time code. */
  oneTimeCodeSecret?: string | null
  /** An empty string clears the label. */
  label?: string
}

export type Outcome<T = undefined> = { ok: true; value: T } | { ok: false; error: string }

// Every code a person can be shown, in plain words. Anything else becomes
// `unknown`, so a new server code can never leak raw text onto the screen.
const ERROR_TEXT: Record<string, string> = {
  invalid_site: "That address doesn't look like a website.",
  insecure_site: 'Use an https address. Only localhost may use http.',
  missing_password: 'Enter a password.',
  too_long: 'One of the values is too long.',
  invalid_one_time_code:
    "That one-time code key isn't valid. Paste the setup key the site showed you.",
  exists: 'You already saved a login for that site.',
  invalid_body: 'Fill in the site and the password.',
  not_found: 'That login is gone. Refresh to see the current list.',
  person_only: 'Only a person can change website logins. An agent cannot.',
  unavailable: "Clawboo couldn't reach its vault. Try again.",
  invalid_token: "That doesn't look like a 1Password service account token.",
  rejected: "1Password didn't accept that token, or it can't read any vault.",
  unreachable: "Couldn't reach 1Password. Try again in a moment.",
  sdk_missing: '1Password support is not installed yet. Choose Connect to install it.',
  install_offline:
    "Couldn't download 1Password support. Check this computer's internet connection or proxy, then try again.",
  install_failed: "Couldn't install 1Password support. The server's log says why. Try again later.",
  rate_limited: 'Too many changes at once. Wait a moment and try again.',
  offline: "Couldn't reach Clawboo. Try again.",
  bad_answer: 'Clawboo sent an answer this page could not read. Try again.',
  unknown: 'Something went wrong. Try again.',
}

const isKnownCode = (code: string): boolean => Object.hasOwn(ERROR_TEXT, code)

export function loginErrorMessage(code: string): string {
  return isKnownCode(code) ? ERROR_TEXT[code]! : ERROR_TEXT['unknown']!
}

async function readBody(res: Response): Promise<Record<string, unknown> | null> {
  const body = (await res.json().catch(() => null)) as unknown
  return body && typeof body === 'object' && !Array.isArray(body)
    ? (body as Record<string, unknown>)
    : null
}

/** The failure code for a non-2xx answer: a known code, or a fixed fallback. */
function errorCode(res: Response, body: Record<string, unknown> | null): string {
  const code = body?.['error']
  if (typeof code === 'string' && isKnownCode(code)) return code
  if (res.status === 429) return 'rate_limited'
  return 'unknown'
}

function isLogin(v: unknown): v is WebsiteLogin {
  if (!v || typeof v !== 'object') return false
  const o = v as Record<string, unknown>
  return typeof o['id'] === 'string' && typeof o['origin'] === 'string'
}

async function send(
  path: string,
  method: string,
  json?: unknown,
): Promise<Outcome<Record<string, unknown> | null>> {
  try {
    const res = await apiFetch(path, {
      method,
      ...(json === undefined
        ? {}
        : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(json) }),
    })
    const body = await readBody(res)
    if (!res.ok || body?.['ok'] === false) return { ok: false, error: errorCode(res, body) }
    return { ok: true, value: body }
  } catch {
    return { ok: false, error: 'offline' }
  }
}

const done = (r: Outcome<unknown>): Outcome =>
  r.ok ? { ok: true, value: undefined } : { ok: false, error: r.error }

export async function fetchWebsiteLogins(): Promise<Outcome<WebsiteLoginsSnapshot>> {
  try {
    const res = await apiFetch('/api/website-logins')
    const body = await readBody(res)
    if (!res.ok || body?.['ok'] === false) return { ok: false, error: errorCode(res, body) }
    const logins = body?.['logins']
    if (!Array.isArray(logins)) return { ok: false, error: 'bad_answer' }
    const op = body?.['onePassword'] as Record<string, unknown> | undefined
    return {
      ok: true,
      value: {
        logins: logins.filter(isLogin).map((l) => ({
          id: l.id,
          origin: l.origin,
          label: typeof l.label === 'string' && l.label ? l.label : null,
          hasUsername: l.hasUsername === true,
          hasOneTimeCode: l.hasOneTimeCode === true,
          createdAt: typeof l.createdAt === 'number' ? l.createdAt : 0,
          updatedAt: typeof l.updatedAt === 'number' ? l.updatedAt : 0,
        })),
        onePassword: {
          connected: op?.['connected'] === true,
          connectedAt: typeof op?.['connectedAt'] === 'number' ? op['connectedAt'] : null,
          sdkInstalled: op?.['sdkInstalled'] === true,
          sdkInstalling: op?.['sdkInstalling'] === true,
        },
        fillAvailable: body?.['fillAvailable'] === true,
      },
    }
  } catch {
    return { ok: false, error: 'offline' }
  }
}

export async function createWebsiteLogin(login: NewLogin): Promise<Outcome> {
  return done(await send('/api/website-logins', 'POST', login))
}

export async function updateWebsiteLogin(id: string, change: LoginChange): Promise<Outcome> {
  return done(await send(`/api/website-logins/${encodeURIComponent(id)}`, 'PATCH', change))
}

export async function deleteWebsiteLogin(id: string): Promise<Outcome> {
  return done(await send(`/api/website-logins/${encodeURIComponent(id)}`, 'DELETE'))
}

/** Downloads 1Password support into Clawboo's runtimes folder, once. Slow the first
 *  time (about 14 MB). */
export async function installOnePasswordSupport(): Promise<Outcome> {
  return done(await send('/api/website-logins/sources/1password/install', 'POST', {}))
}

/** Connects 1Password; answers how many vaults the token can read. */
export async function connectOnePassword(token: string): Promise<Outcome<number | null>> {
  const r = await send('/api/website-logins/sources/1password', 'PUT', { token })
  if (!r.ok) return r
  const vaults = r.value?.['vaults']
  return { ok: true, value: typeof vaults === 'number' ? vaults : null }
}

export async function disconnectOnePassword(): Promise<Outcome> {
  return done(await send('/api/website-logins/sources/1password', 'DELETE'))
}
