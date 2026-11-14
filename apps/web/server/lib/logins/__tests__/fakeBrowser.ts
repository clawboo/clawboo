// A fake browser for the login-fill tests: each page is a jsdom document at a real
// address, and the page functions the fill sends (the real ones) are evaluated in
// it, the way the browser connectors run them in the agent's current tab.

// jsdom ships no type declarations and @types/jsdom is not a dependency, so the
// small part used here is typed by hand.
// @ts-expect-error -- an untyped module
import { JSDOM as UntypedJSDOM } from 'jsdom'

import { callExpression, type AgentPageRunner } from '../browserLink'

interface Dom {
  window: Window & typeof globalThis & { eval(code: string): unknown }
}
const JSDOM = UntypedJSDOM as new (
  html: string,
  opts: { url: string; runScripts: 'outside-only' },
) => Dom

export interface FakePageInit {
  url: string
  html: string
  /** What the browser reports as the main frame's address, when it differs from
   *  the document's own (a tab whose frame state and document disagree). */
  frameUrl?: string
  /** The browser reports a certificate error on this page. */
  certificateError?: boolean
}

export interface FakePage {
  targetId: string
  dom: Dom
  init: FakePageInit
  /** Every `input` event a field received, by the field's id. */
  inputEvents: string[]
}

/** jsdom lays nothing out, so every element is given a box unless it is hidden. */
function giveElementsABox(dom: Dom): void {
  const win = dom.window
  win.HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
    const style = win.getComputedStyle(this)
    const hidden = style.display === 'none' || style.visibility === 'hidden'
    const w = hidden ? 0 : 120
    const h = hidden ? 0 : 40
    // A box pushed off the page with a negative left offset sits left of it.
    const offset = parseFloat(style.left)
    const x = Number.isFinite(offset) && offset < 0 ? offset : 0
    return { x, y: 0, width: w, height: h, top: 0, left: x, right: x + w, bottom: h, toJSON() {} }
  }
}

export function makePage(targetId: string, init: FakePageInit): FakePage {
  const dom = new JSDOM(init.html, { url: init.url, runScripts: 'outside-only' })
  giveElementsABox(dom)
  const page: FakePage = { targetId, dom, init, inputEvents: [] }
  dom.window.document.addEventListener(
    'input',
    (e: Event) => page.inputEvents.push((e.target as HTMLElement).id),
    true,
  )
  return page
}

export interface RecordedRun {
  fn: string
  args: readonly unknown[]
}

/**
 * The agent's browser as the fill reaches it through a connector: a page function
 * run in the main frame of its current tab (`pages[0]`). Like Playwright, it reads
 * the frame's address from the browser and evaluates nothing off the expected origin.
 */
export class FakeBrowser {
  readonly runs: RecordedRun[] = []
  /** Runs right before the call that carries values, to simulate a page that
   *  navigates between the probe and the fill. Return the page it is now. */
  beforeFill: ((page: FakePage) => FakePage | void) | null = null

  constructor(public pages: FakePage[]) {}

  readonly runner: AgentPageRunner = async (_owner, fn, args, expectedOrigin) => {
    this.runs.push({ fn, args })
    let page = this.pages[0]
    if (!page) return { kind: 'no_browser' }
    if (args.length > 0 && this.beforeFill) {
      const next = this.beforeFill(page)
      if (next) page = next
    }
    const frameUrl = page.init.frameUrl ?? page.dom.window.location.href
    let origin: string | null = null
    try {
      origin = new URL(frameUrl).origin
    } catch {
      origin = null
    }
    if (origin !== expectedOrigin) return { kind: 'ran', frameUrl, value: undefined }
    if (page.init.certificateError && expectedOrigin.startsWith('https:'))
      return { kind: 'insecure' }
    const value = page.dom.window.eval(callExpression(fn, args))
    return { kind: 'ran', frameUrl, value: JSON.parse(JSON.stringify(value)) as unknown }
  }

  /** Every run that carried values into a page. */
  valueRuns(): RecordedRun[] {
    return this.runs.filter((r) => r.args.length > 0)
  }
}

export const LOGIN_FORM = `<!doctype html><html><body>
  <form action="/session" method="post">
    <input id="user" name="email" type="email" autocomplete="username" />
    <input id="pass" name="password" type="password" autocomplete="current-password" />
    <button type="submit">Sign in</button>
  </form>
</body></html>`

export const LOGIN_FORM_WITH_CODE = `<!doctype html><html><body>
  <form action="/session" method="post">
    <input id="user" name="email" type="email" autocomplete="username" />
    <input id="pass" name="password" type="password" autocomplete="current-password" />
    <input id="code" name="otp" type="text" autocomplete="one-time-code" inputmode="numeric" />
    <button type="submit">Sign in</button>
  </form>
</body></html>`

export const CAPTCHA_FORM = `<!doctype html><html><body>
  <form>
    <input id="user" name="email" type="email" autocomplete="username" />
    <input id="pass" name="password" type="password" autocomplete="current-password" />
    <iframe title="reCAPTCHA" src="https://www.google.com/recaptcha/api2/anchor?k=x"></iframe>
  </form>
</body></html>`

export const CARD_CHECK_PAGE = `<!doctype html><html><body>
  <iframe name="__privateStripeFrame3ds" src="https://js.stripe.com/v3/three-ds-2-challenge.html"></iframe>
</body></html>`

export const NO_FORM_PAGE = `<!doctype html><html><body><h1>Welcome</h1><p>Nothing to fill.</p></body></html>`
