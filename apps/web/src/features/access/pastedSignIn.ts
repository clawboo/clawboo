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

/** The shape the access gate gives a launch code (`LAUNCH_CODE_SHAPE` there). */
const LAUNCH_CODE_SHAPE = /^[A-Za-z0-9_-]{16,256}$/

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
  if (LAUNCH_CODE_SHAPE.test(text)) return { ok: true, code: text }

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
  if (!LAUNCH_CODE_SHAPE.test(code)) return { ok: false, reason: 'not-a-link' }
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
