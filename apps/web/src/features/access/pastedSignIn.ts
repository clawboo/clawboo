// Signing in by pasting a one-time link on the locked screen. An app added to an
// iPhone's home screen keeps its cookies apart from Safari's, and a tapped link
// opens in Safari, so the app itself never sees the link. Pasting it is how that
// app gets in.
//
// Only the code is taken from what was pasted, and only from a link for this
// very dashboard. The screen then submits the code the way the server's own
// sign-in page does: a form POST to `?access_code=` on this dashboard's page,
// which the access gate spends once, within its two minutes, and answers with
// the same cookie and a 303 to the page without the code. Nothing goes to the
// pasted address, and the code never lands in the address bar or in storage.

/**
 * A launch code: 24 random bytes in base64url, so always 32 characters
 * (`mintLaunchCode` in the access gate). Nothing else is ever posted. The
 * per-install access token is 43 characters of the same alphabet, and posting
 * it as a code would put the long-lived token in the request line, where a
 * reverse proxy's access log records it.
 */
const LAUNCH_CODE = /^[A-Za-z0-9_-]{32}$/

/**
 * 32 hex digits, as `openssl rand -hex 16` makes for a token set by hand. A
 * real code is all hex about once in 10^15, so such a value is a token.
 */
const HEX_TOKEN = /^[0-9a-f]{32}$/i

/**
 * The access token's characters, less `.`, so that a bare host name such as
 * `dash.example.com` reads as a link and not as a token.
 */
const TOKEN_LIKE = /^[A-Za-z0-9_~-]{16,}$/

/** Is this value a launch code, something that looks like the token, or neither? */
function readCode(value: string): 'code' | 'token' | 'neither' {
  if (LAUNCH_CODE.test(value) && !HEX_TOKEN.test(value)) return 'code'
  return TOKEN_LIKE.test(value) ? 'token' : 'neither'
}

/** Longer than any link the dashboard or `clawboo open` makes, by a wide margin. */
const MAX_PASTED_LENGTH = 2048

/**
 * Added to the address the code is posted to. The gate strips only the code on
 * its redirect, so this comes back on the page that loads next, and tells the
 * locked screen that a pasted link was just tried and did not sign it in.
 */
const MARK = 'signin'
const MARK_VALUE = 'pasted'

export type PastedSignIn =
  | { ok: true; code: string }
  | { ok: false; reason: 'empty' | 'not-a-link' | 'token' | 'other-dashboard' }
  | { ok: false; reason: 'elsewhere'; linkOrigin: string }

/** Where this dashboard is: the page's origin and its mount ('' at the root). */
export interface DashboardAddress {
  origin: string
  base: string
}

/** A scheme followed by `//`, so `dash.example.com:8443/…` is not read as one. */
const HAS_SCHEME = /^[a-z][a-z0-9+.-]*:\/\//i

/** What a pasted link or code signs in with, or why it cannot. */
export function readPastedSignIn(pasted: string, here: DashboardAddress): PastedSignIn {
  // A link never holds whitespace; a chat app or a wrapped line can add some.
  const text = pasted.replace(/\s+/g, '')
  if (text === '') return { ok: false, reason: 'empty' }
  if (text.length > MAX_PASTED_LENGTH) return { ok: false, reason: 'not-a-link' }
  const bare = readCode(text)
  if (bare === 'code') return { ok: true, code: text }
  if (bare === 'token') return { ok: false, reason: 'token' }

  let link: URL
  try {
    // Some apps show a link without its scheme; read it as one on this page's.
    const scheme = new URL(here.origin).protocol
    link = new URL(HAS_SCHEME.test(text) ? text : `${scheme}//${text}`)
  } catch {
    return { ok: false, reason: 'not-a-link' }
  }
  if (link.protocol !== 'https:' && link.protocol !== 'http:') {
    return { ok: false, reason: 'not-a-link' }
  }
  // The token itself is not a one-time link, and is never sent on from here.
  if (link.searchParams.has('access_token')) return { ok: false, reason: 'token' }
  const codes = link.searchParams.getAll('access_code')
  const code = codes.length === 1 ? codes[0]! : ''
  const reading = readCode(code)
  if (reading === 'token') return { ok: false, reason: 'token' }
  if (reading !== 'code') return { ok: false, reason: 'not-a-link' }
  // The browser keeps cookies per origin, and the code is for one server.
  if (link.origin !== here.origin) {
    return { ok: false, reason: 'elsewhere', linkOrigin: link.origin }
  }
  // The dashboard's page is `<mount>/`, the address every sign-in link names.
  const page = `${here.base}/`
  if (link.pathname !== page && !(here.base !== '' && link.pathname === here.base)) {
    return { ok: false, reason: 'other-dashboard' }
  }
  return { ok: true, code }
}

/** The address the code is posted to: this dashboard's own page, never the pasted one. */
export function signInAction(code: string, base: string): string {
  return `${base}/?${MARK}=${MARK_VALUE}&access_code=${encodeURIComponent(code)}`
}

/**
 * Sign in with a code: submit it as the server's sign-in page does, a form POST
 * that the access gate spends once and answers with a 303 to this dashboard's
 * page. A whole-page load, so the next page starts with the cookie.
 */
export function submitSignIn(code: string, base: string, doc: Document = document): void {
  const form = doc.createElement('form')
  // Form-encoded, with no fields: the gate reads the code from the address.
  form.method = 'post'
  form.action = signInAction(code, base)
  form.hidden = true
  doc.body.appendChild(form)
  form.submit()
}

/**
 * True when a redirect brought this page load here, as the gate's 303 after the
 * posted form does. An address typed or shared with the mark in it arrives with
 * none, so the mark alone does not say a pasted link was refused. Navigation
 * Timing counts same-origin redirects, which the gate's is; a browser that does
 * not say counts as no redirect.
 */
export function arrivedByRedirect(
  timing: Partial<Pick<Performance, 'getEntriesByType'>> | undefined = globalThis.performance,
): boolean {
  try {
    const [load] = timing?.getEntriesByType?.('navigation') ?? []
    return ((load as PerformanceNavigationTiming | undefined)?.redirectCount ?? 0) > 0
  } catch {
    return false
  }
}

/** Did a pasted link just come back from the server without signing in? */
export function hasPastedMark(search: string): boolean {
  return new URLSearchParams(search).get(MARK) === MARK_VALUE
}

/** `href` without the mark, as a path for `history.replaceState`; null when it has none. */
export function withoutPastedMark(href: string): string | null {
  const url = new URL(href)
  if (!hasPastedMark(url.search)) return null
  url.searchParams.delete(MARK)
  return `${url.pathname}${url.search}${url.hash}`
}
