// The fill itself, in the agent's own browser, through its browser connector
// (browserLink.ts).
//
// THE ORDER, and why:
//   1. PROBE with no values, in the main frame of the agent's current tab: which
//      fields are there, and is a CAPTCHA, passkey or card check in the way. The
//      page's origin must be exactly the login's, read from the browser's own
//      state where the connector can (Playwright) and from the page's
//      `location.origin`, which a page cannot fake, always. What the agent says
//      about where it is counts for nothing. A page with nothing to fill never
//      receives a value, and a field that is absent never receives its value.
//   2. FILL in one call: the function checks `location.origin` again and finds
//      the fields again, in the same JavaScript task that sets them, so a page that
//      navigated in between gets nothing, and a page that changed its fields gets
//      only what it now shows.
//
// Fields are found through the DOM's prototypes, so a page's own markup (a field
// named like a form property) cannot redirect the fill. A field whose form posts to
// another origin, or that nobody can see, is never filled. A same-origin script on
// the page can read a field once it is filled; nothing here can stop that.
//
// What comes back from the page is a status and the names of the fields filled.
// No value is ever read back, logged or returned.

import { createLogger } from '@clawboo/logger'

import { isPersonInControlOf, runInAgentPage, type BrowserOwner } from './browserLink'
import { pageOriginOf } from './origin'

const log = createLogger('website-logins')

/** An error's class name, never its message: a page call's message can quote the call. */
export function errorClass(err: unknown): string {
  return err instanceof Error ? err.name : typeof err
}

export type FillField = 'username' | 'password' | 'one_time_code'
export type FillBlocker = 'captcha' | 'passkey' | 'card_check'

export type PageFillResult =
  | { kind: 'filled'; fields: FillField[]; blocker: FillBlocker | null }
  | { kind: 'blocked'; blocker: FillBlocker }
  | { kind: 'not_on_site' }
  | { kind: 'no_form' }
  | { kind: 'no_browser' }
  | { kind: 'not_granted' }
  | { kind: 'insecure' }
  | { kind: 'unverifiable' }
  | { kind: 'person_in_control' }
  | { kind: 'failed' }

export interface PageFillValues {
  username: string
  password: string
  /** The current one-time code, when the login has a secret for one. */
  oneTimeCode: string | null
}

/** Finding the fields, shared word for word by the probe and the fill so they agree. */
const FIND_FIELDS = String.raw`
  // DOM methods through their prototypes: a page can shadow a form's own properties
  // with a field named after them (an input named action), in every world.
  const qsa = (root, sel) => Array.from(Document.prototype.querySelectorAll.call(root, sel))
  const attr = (el, name) => Element.prototype.getAttribute.call(el, name)
  const formOf = (el) => Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'form').get.call(el)
  const within = (root, el) => Node.prototype.contains.call(root, el)
  const visible = (el) => {
    if (!el || el.disabled || el.readOnly) return false
    if (el.type === 'hidden') return false
    const win = el.ownerDocument.defaultView
    // Hidden by any box it sits in, or so faint nobody could see it.
    for (let n = el, depth = 0; n && n.nodeType === 1 && depth < 32; n = n.parentElement, depth++) {
      const style = win.getComputedStyle(n)
      if (style.visibility === 'hidden' || style.display === 'none') return false
      if (Number(style.opacity) < 0.1) return false
    }
    const r = el.getBoundingClientRect()
    if (r.width < 2 || r.height < 2) return false
    // Pushed off the page to the left or above it.
    return r.right > 0 && r.bottom > 0
  }
  // Where a form or a button sends its data, as the browser resolves it: against
  // the document's base address, so a <base href> pointing elsewhere counts. Read
  // through the prototype getter, which resolves exactly as a submission does, or,
  // where a browser has none, the attribute against the node's base address.
  const baseOf = (el) => Object.getOwnPropertyDescriptor(Node.prototype, 'baseURI').get.call(el)
  const resolved = (proto, name, el, attrName) => {
    const own = Object.getOwnPropertyDescriptor(proto, name)
    if (own && own.get) return own.get.call(el)
    const raw = attr(el, attrName)
    if (raw === null || raw === '') return location.href
    try { return new URL(raw, baseOf(el)).href } catch (e) { return null }
  }
  const sameOrigin = (url) => {
    try { return new URL(url).origin === location.origin } catch (e) { return false }
  }
  const buttonTarget = (b) =>
    resolved(b.tagName === 'BUTTON' ? HTMLButtonElement.prototype : HTMLInputElement.prototype, 'formAction', b, 'formaction')
  // A field whose form sends it to another site is not this site's sign-in form,
  // whatever it looks like: neither the form nor any of its buttons may post away.
  const postsHome = (el) => {
    const form = formOf(el)
    if (!form) return true
    if (!sameOrigin(resolved(HTMLFormElement.prototype, 'action', form, 'action'))) return false
    return !qsa(document, 'button[formaction], input[formaction]').some(
      (b) =>
        (within(form, b) || (attr(b, 'form') !== null && attr(b, 'form') === attr(form, 'id'))) &&
        !sameOrigin(buttonTarget(b)),
    )
  }
  const ac = (el) => (attr(el, 'autocomplete') || '').toLowerCase()
  const named = (el, re) =>
    re.test([attr(el, 'name'), attr(el, 'id'), attr(el, 'aria-label'), attr(el, 'placeholder')].join(' '))
  const inputs = qsa(document, 'input').filter((el) => visible(el) && postsHome(el))
  const passwords = inputs.filter((el) => el.type === 'password')
  let password = passwords.find((el) => ac(el).split(/\s+/).includes('current-password')) || null
  if (!password) {
    const notNew = passwords.filter((el) => !ac(el).split(/\s+/).includes('new-password'))
    if (notNew.length === 1) password = notNew[0]
  }
  const scope = (password && formOf(password)) || document
  const textLike = (el) => ['text', 'email', 'tel', ''].includes(el.type)
  const scoped = inputs.filter((el) => scope === document || within(scope, el))
  const USER_RE = /user|e-?mail|login|account|identifier|signin/i
  let username =
    scoped.find((el) => textLike(el) && /\b(username|email)\b/.test(ac(el))) ||
    scoped.find((el) => el.type === 'email') ||
    scoped.find((el) => textLike(el) && named(el, USER_RE) && !/one-time-code/.test(ac(el))) ||
    null
  if (!username && password) {
    const before = scoped.filter(
      (el) => textLike(el) && (el.compareDocumentPosition(password) & Node.DOCUMENT_POSITION_FOLLOWING),
    )
    username = before.length ? before[before.length - 1] : null
  }
  const OTP_RE = /otp|totp|one.?time|2fa|mfa|two.?factor|verification.?code|auth.?code|security.?code/i
  const oneTimeCode =
    inputs.find((el) => ac(el).split(/\s+/).includes('one-time-code')) ||
    inputs.find((el) => textLike(el) && el !== username && named(el, OTP_RE)) ||
    null
  const seen = (sel) => qsa(document, sel).some((el) => {
    const r = el.getBoundingClientRect()
    return r.width >= 30 && r.height >= 30
  })
  const CAPTCHA =
    'iframe[src*="recaptcha/api2/anchor"], iframe[src*="recaptcha/enterprise/anchor"], ' +
    'iframe[src*="recaptcha/api2/bframe"], iframe[src*="hcaptcha.com"], ' +
    'iframe[src*="challenges.cloudflare.com"], iframe[title*="captcha" i], ' +
    '.g-recaptcha, .h-captcha, .cf-turnstile, img[src*="captcha" i]'
  const CARD =
    'iframe[src*="3ds" i], iframe[name*="3ds" i], iframe[src*="threeds" i], ' +
    'iframe[src*="cardinalcommerce" i], iframe[name*="challenge" i][src*="stripe" i], ' +
    'input[autocomplete^="cc-"]'
  const pageText = (document.body && document.body.innerText) || ''
  let blocker = null
  if (seen(CAPTCHA) || /^just a moment/i.test(document.title)) blocker = 'captcha'
  else if (!password && !username && seen(CARD)) blocker = 'card_check'
  else if (
    !password &&
    (inputs.some((el) => /webauthn/.test(ac(el))) || /\bpass ?key\b|security key/i.test(pageText.slice(0, 20000))) &&
    !inputs.some((el) => textLike(el))
  )
    blocker = 'passkey'
`

/** Runs with no values: what is there to fill, and what is in the way. */
const PROBE_FN = `function () {
  ${FIND_FIELDS}
  return {
    origin: location.origin,
    username: !!username,
    password: !!password,
    oneTimeCode: !!oneTimeCode,
    blocker,
  }
}`

/** Runs with the values: checks the origin and finds the fields again in the same
 *  task, sets each present field through the native setter, and says which. */
const FILL_FN = `function (expectedOrigin, user, pass, code) {
  if (location.origin !== expectedOrigin) return { status: 'not_on_site', fields: [] }
  ${FIND_FIELDS}
  if (blocker === 'card_check' || blocker === 'passkey') return { status: 'blocked', blocker, fields: [] }
  const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set
  const put = (el, value) => {
    el.focus()
    setter.call(el, value)
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
  const fields = []
  if (username && typeof user === 'string' && user) { put(username, user); fields.push('username') }
  if (password && typeof pass === 'string' && pass) { put(password, pass); fields.push('password') }
  if (oneTimeCode && typeof code === 'string' && code) { put(oneTimeCode, code); fields.push('one_time_code') }
  if (fields.length === 0) return { status: 'no_form', fields: [] }
  return { status: 'filled', fields, blocker }
}`

export const PAGE_FILL_SOURCES = { probe: PROBE_FN, fill: FILL_FN } as const

interface ProbeValue {
  origin: string
  username: boolean
  password: boolean
  oneTimeCode: boolean
  blocker: FillBlocker | null
}

const BLOCKERS: ReadonlySet<string> = new Set(['captcha', 'passkey', 'card_check'])
const FIELDS: ReadonlySet<string> = new Set(['username', 'password', 'one_time_code'])

function asProbe(v: unknown): ProbeValue | null {
  if (!v || typeof v !== 'object') return null
  const o = v as Record<string, unknown>
  if (typeof o['origin'] !== 'string') return null
  const blocker =
    typeof o['blocker'] === 'string' && BLOCKERS.has(o['blocker']) ? o['blocker'] : null
  return {
    origin: o['origin'],
    username: o['username'] === true,
    password: o['password'] === true,
    oneTimeCode: o['oneTimeCode'] === true,
    blocker: blocker as FillBlocker | null,
  }
}

/** Whether a frame address a backend reported is somewhere else. Null: it could not say. */
const frameElsewhere = (frameUrl: string | null, origin: string): boolean =>
  frameUrl !== null && pageOriginOf(frameUrl) !== origin

/**
 * Fill the login form on the agent's current tab, which must be on `origin`.
 *
 * `valuesFor` is called only once the page shows a field to fill and nothing that
 * stops the fill, so a value is fetched (from the vault or a password manager)
 * only when it will be used.
 */
export async function fillLoginOnPage(
  owner: BrowserOwner,
  origin: string,
  valuesFor: (present: {
    username: boolean
    password: boolean
    oneTimeCode: boolean
  }) => Promise<PageFillValues | null>,
): Promise<PageFillResult | { kind: 'no_login' }> {
  const agentId = owner.agentId
  if (isPersonInControlOf(agentId)) return { kind: 'person_in_control' }
  let probed
  try {
    probed = await runInAgentPage(owner, PROBE_FN, [], origin)
  } catch (err) {
    log.warn({ agentId, err: errorClass(err) }, 'login fill: the probe failed')
    return { kind: 'failed' }
  }
  if (probed.kind !== 'ran') return probed
  if (frameElsewhere(probed.frameUrl, origin)) return { kind: 'not_on_site' }
  const probe = asProbe(probed.value)
  if (!probe)
    return probed.value === undefined && probed.frameUrl !== null
      ? { kind: 'not_on_site' }
      : { kind: 'failed' }
  if (probe.origin !== origin) return { kind: 'not_on_site' }
  if (probe.blocker === 'card_check' || probe.blocker === 'passkey') {
    return { kind: 'blocked', blocker: probe.blocker }
  }
  if (!probe.username && !probe.password && !probe.oneTimeCode) {
    return probe.blocker ? { kind: 'blocked', blocker: probe.blocker } : { kind: 'no_form' }
  }

  const values = await valuesFor({
    username: probe.username,
    password: probe.password,
    oneTimeCode: probe.oneTimeCode,
  })
  if (!values) return { kind: 'no_login' }
  // A person may have taken over while the values were fetched.
  if (isPersonInControlOf(agentId)) return { kind: 'person_in_control' }

  let filled
  try {
    // Only what the page showed a field for leaves this process.
    filled = await runInAgentPage(
      owner,
      FILL_FN,
      [
        origin,
        probe.username ? values.username : null,
        probe.password ? values.password : null,
        probe.oneTimeCode ? values.oneTimeCode : null,
      ],
      origin,
    )
  } catch (err) {
    // A page that navigated mid-fill, or a browser that closed: the values went
    // nowhere the fill can see, and nothing here repeats them. The class only:
    // an error from the page call could quote the call.
    log.warn({ agentId, err: errorClass(err) }, 'login fill: the fill call failed')
    return { kind: 'failed' }
  }
  if (filled.kind === 'insecure') return { kind: 'insecure' }
  if (filled.kind !== 'ran') return { kind: 'failed' }
  if (frameElsewhere(filled.frameUrl, origin)) return { kind: 'not_on_site' }
  const out = filled.value as { status?: unknown; fields?: unknown; blocker?: unknown } | undefined
  const status = typeof out?.status === 'string' ? out.status : ''
  if (status === 'not_on_site') return { kind: 'not_on_site' }
  if (status === 'blocked') {
    const b = typeof out?.blocker === 'string' && BLOCKERS.has(out.blocker) ? out.blocker : null
    return b ? { kind: 'blocked', blocker: b as FillBlocker } : { kind: 'failed' }
  }
  if (status === 'no_form') return { kind: 'no_form' }
  if (status !== 'filled') return { kind: 'failed' }
  const fields = (Array.isArray(out?.fields) ? out.fields : []).filter(
    (f): f is FillField => typeof f === 'string' && FIELDS.has(f),
  )
  const blocker =
    typeof out?.blocker === 'string' && BLOCKERS.has(out.blocker)
      ? (out.blocker as FillBlocker)
      : null
  return { kind: 'filled', fields, blocker }
}
