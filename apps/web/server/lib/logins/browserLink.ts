// How the login fill reaches an agent's own browser: through the browser
// connector session the server already holds for that agent, never through a
// debugging port.
//
// Both browser connectors start Chrome over a pipe only the connector process
// holds. Chrome would serve the DevTools protocol to anyone else only on a TCP
// port, which every local user can open, so a separate endpoint would hand any of
// them the agent's signed-in browser. The fill therefore asks the connector to run
// a page function in the agent's current tab, server-side (`callIfRunning`): not
// through the tool broker, so the call is in no audit row, no event and nothing
// the model sees, and never starting a browser.
//
// - Playwright (`browser_run_code_unsafe`): the code reads the main frame's address
//   from Playwright's own state first and evaluates nothing when it is not the
//   login's origin. It then opens a DevTools session on that page through
//   Playwright, reads the browser's own security state (a certificate error
//   refuses the fill, as plain http does; a browser build that reports no state,
//   such as Playwright's bare headless shell, cannot vouch for the certificate and
//   is refused too), and runs the page function in an
//   isolated world it makes for the main frame: page scripts share the DOM with
//   that world but not its JavaScript, so no page hook (a replaced `eval`, a
//   patched prototype) sees the values, even on a page the tab moved to.
// - Chrome DevTools (`evaluate_script`): the page function checks
//   `location.origin` itself, in the same task that fills. This connector has no
//   way to read the page's certificate, so it fills only a plain-http loopback
//   site; an https site is refused there and filled in the Playwright browser.
//
// Which connectors the fill may use is the agent's grant, at grant level: the two
// page-run tools are destructive (they need Admin), and the fill never hands them
// to the agent, so what matters is that the agent holds the browser at all.
//
// The values travel in the call's arguments to the connector process, which runs
// as the agent user when agents run as their own user: the same exposure as the
// value once it is in the page. Playwright echoes the code back in its answer;
// only the result is read from it and the rest is dropped here.

import { getConnector, listCandidateGrants } from '@clawboo/db'
import { decideGrant } from '@clawboo/governance'
import { createLogger } from '@clawboo/logger'

import { getDb } from '../db'

import { connectorInstanceIdForSlug } from '../capabilitySource/connectorIdentity'
import { callIfRunning } from '../connectors/agentBrowsers'
import { getLiveConnector } from '../connectors/supervisor'

const log = createLogger('website-logins')

/** What a page function run in the agent's current tab gave back. */
export interface PageRun {
  kind: 'ran'
  /** The main frame's address, as the browser reports it, when the backend can
   *  say. Null when it cannot (the function then checks the origin itself). */
  frameUrl: string | null
  /** The function's JSON result, or undefined when it was not run (the main frame
   *  was not on the expected origin) or its answer could not be read. */
  value: unknown
}

/**
 * What running a page function came to: it ran (or was skipped off the origin),
 * the agent has no browser open, the agent holds no browser connector, the page's
 * certificate is broken, or the backend cannot check the certificate of an https
 * site.
 */
export type PageRunResult =
  | PageRun
  | { kind: 'no_browser' }
  | { kind: 'not_granted' }
  | { kind: 'insecure' }
  | { kind: 'unverifiable' }

/** Whose browser, and the team whose grants may cover it. */
export interface BrowserOwner {
  agentId: string
  teamId?: string | null
}

/**
 * Run `fn` (a function's source, called with `args`) in the main frame of the
 * agent's current tab. `expectedOrigin` lets a backend that can read the frame's
 * address skip a page on another origin without evaluating anything there. Never
 * starts a browser.
 */
export type AgentPageRunner = (
  owner: BrowserOwner,
  fn: string,
  args: readonly unknown[],
  expectedOrigin: string,
) => Promise<PageRunResult>

/** Whether a person holds control of this agent's browser right now (take over). */
export type PersonInControl = (agentId: string) => boolean

const RUN_CODE_TOOL = 'browser_run_code_unsafe'
const EVALUATE_TOOL = 'evaluate_script'

/**
 * The expression a backend evaluates: `fn` called directly, each argument a JSON
 * literal. Directly, not through `.apply` or any other property the page can
 * replace: the expression may run in a page that moved to another site after the
 * probe, and the function's first statement (the `location.origin` check, which a
 * page cannot fake) must run before anything that page could hook sees a value.
 */
export function callExpression(fn: string, args: readonly unknown[]): string {
  return `(${fn})(${args.map((a) => JSON.stringify(a ?? null)).join(', ')})`
}

/** The Playwright code for one run.
 *
 *  Playwright runs it in a bare `vm` context with only `page` in scope: no `URL`,
 *  no timers, no Node globals. So the origin test is on the browser's canonical
 *  address (lower-case host, default port dropped, punycode): it must be the origin
 *  itself or the origin followed by `/`, `?` or `#`, which a longer host, a port or
 *  a userinfo trick never is. It is made twice: on Playwright's own frame state
 *  before anything else, and on the frame tree the DevTools session reports.
 *
 *  The page function runs through that session's `Runtime.evaluate` in an isolated
 *  world, not through `frame.evaluate`, which Playwright passes to the page's own
 *  `eval`: a page could replace that and read the values before the function's
 *  origin check. For an https origin, the browser's security state must show no
 *  certificate error (Chrome reports one as `insecure-broken` with the error named).
 *  Chrome and Chromium report a state, headless or not; Playwright's bare headless
 *  shell reports none, and a certificate nothing vouches for is not filled. */
export function playwrightCode(
  fn: string,
  args: readonly unknown[],
  expectedOrigin: string,
): string {
  return `async (page) => {
  const origin = ${JSON.stringify(expectedOrigin)}
  const onOrigin = (u) => u === origin || ['/', '?', '#'].some((c) => u.startsWith(origin + c))
  const frameUrl = page.mainFrame().url()
  if (!onOrigin(frameUrl)) return { frameUrl, ran: false }
  const cdp = await page.context().newCDPSession(page)
  try {
    const states = []
    cdp.on('Security.visibleSecurityStateChanged', (e) => states.push(e.visibleSecurityState))
    await cdp.send('Security.enable')
    for (let i = 0; i < 40 && states.length === 0; i++) await page.waitForTimeout(25)
    const { frameTree } = await cdp.send('Page.getFrameTree')
    const url = frameTree.frame.url
    if (!onOrigin(url)) return { frameUrl: url, ran: false }
    if (origin.startsWith('https:')) {
      const state = states[states.length - 1]
      if (!state) return { frameUrl: url, ran: false, unverifiable: true }
      const cert = state.certificateSecurityState
      if (state.securityState === 'insecure-broken' || (cert && cert.certificateNetworkError))
        return { frameUrl: url, ran: false, insecure: true }
    }
    const { executionContextId } = await cdp.send('Page.createIsolatedWorld', {
      frameId: frameTree.frame.id,
      worldName: 'clawboo-login-fill',
      grantUniveralAccess: false,
    })
    const evaluated = await cdp.send('Runtime.evaluate', {
      expression: ${JSON.stringify(callExpression(fn, args))},
      contextId: executionContextId,
      returnByValue: true,
    })
    if (evaluated.exceptionDetails) return { frameUrl: url, ran: true, value: null }
    return { frameUrl: url, ran: true, value: evaluated.result.value }
  } finally {
    await cdp.detach().catch(() => undefined)
  }
}`
}

/** The result section of a Playwright MCP answer: `### Result` up to the next heading. */
export function playwrightResult(
  text: string,
): PageRun | { kind: 'insecure' } | { kind: 'unverifiable' } | null {
  const at = text.indexOf('### Result\n')
  if (at < 0) return null
  const rest = text.slice(at + '### Result\n'.length)
  const end = rest.indexOf('\n### ')
  const body = (end < 0 ? rest : rest.slice(0, end)).trim()
  try {
    const parsed = JSON.parse(body) as {
      frameUrl?: unknown
      ran?: unknown
      value?: unknown
      insecure?: unknown
      unverifiable?: unknown
    }
    if (parsed.insecure === true) return { kind: 'insecure' }
    if (parsed.unverifiable === true) return { kind: 'unverifiable' }
    return {
      kind: 'ran',
      frameUrl: typeof parsed.frameUrl === 'string' ? parsed.frameUrl : null,
      value: parsed.ran === true ? parsed.value : undefined,
    }
  } catch {
    return null
  }
}

/** The JSON a DevTools MCP `evaluate_script` answer carries. */
export function devtoolsResult(text: string): PageRun | null {
  const m = /Script ran on page and returned:\s*```json\s*\n([\s\S]*?)\n```/.exec(text)
  if (!m) return null
  try {
    return { kind: 'ran', frameUrl: null, value: JSON.parse(m[1] as string) as unknown }
  } catch {
    return null
  }
}

/** A read-only stand-in, for a grant-level decision: no tool is being called. */
const GRANT_PROBE = { name: '(login fill)', readOnly: true } as const

/**
 * Whether this browser connector is live, offers `rawName`, and is the agent's to
 * use: its agent or team grant authorizes something right now (not revoked,
 * suspended, expired or drifted). Decided at grant level, as the graph decides a
 * grant: the page-run tools are destructive and need Admin, which a browser grant
 * (Write) never gives, and the fill never hands them to the agent.
 */
function browserAccess(
  slug: string,
  rawName: string,
  owner: BrowserOwner,
): { connectorId: string } | 'absent' | 'not_granted' {
  const connectorId = connectorInstanceIdForSlug(slug)
  const live = getLiveConnector(connectorId)
  if (!live) return 'absent'
  if (![...live.rawToolNames.values()].includes(rawName)) return 'absent'
  const db = getDb()
  const connector = getConnector(db, connectorId)
  const decision = decideGrant({
    grants: listCandidateGrants(db, {
      agentId: owner.agentId,
      teamId: owner.teamId ?? null,
      connectorId,
    }),
    tool: GRANT_PROBE,
    currentSpecHash: connector?.specHash ?? null,
    currentToolsHash: connector?.toolsHash ?? null,
    now: Date.now(),
    grantLevelOnly: true,
  })
  return decision.kind === 'deny' ? 'not_granted' : { connectorId }
}

/** Whether an origin is plain http on a loopback host: its page has no certificate. */
function plainLoopback(origin: string): boolean {
  return origin.startsWith('http://')
}

/** The runner over the two browser connectors, Playwright first. */
const connectorRunner: AgentPageRunner = async (owner, fn, args, expectedOrigin) => {
  const { agentId } = owner
  let granted = false
  let unverifiable = false
  const playwright = browserAccess('playwright', RUN_CODE_TOOL, owner)
  if (typeof playwright === 'object') {
    granted = true
    const res = await callIfRunning(playwright.connectorId, agentId, RUN_CODE_TOOL, {
      code: playwrightCode(fn, args, expectedOrigin),
    })
    if (res) return playwrightResult(res.text) ?? { kind: 'ran', frameUrl: null, value: undefined }
  }
  const devtools = browserAccess('chrome-devtools', EVALUATE_TOOL, owner)
  if (typeof devtools === 'object') {
    granted = true
    // This connector cannot read the page's certificate, so it fills only a site
    // that has none to check (plain http, which origins allow only on loopback).
    if (plainLoopback(expectedOrigin)) {
      const res = await callIfRunning(devtools.connectorId, agentId, EVALUATE_TOOL, {
        function: `() => ${callExpression(fn, args)}`,
      })
      if (res) return devtoolsResult(res.text) ?? { kind: 'ran', frameUrl: null, value: undefined }
    } else {
      unverifiable = true
    }
  }
  if (unverifiable) return { kind: 'unverifiable' }
  if (granted) return { kind: 'no_browser' }
  if (playwright === 'not_granted' || devtools === 'not_granted') {
    log.info({ agentId }, 'login fill: the agent holds no browser connector')
    return { kind: 'not_granted' }
  }
  return { kind: 'no_browser' }
}

let runner: AgentPageRunner = connectorRunner
/** A runner put in place of the connectors (tests): it counts as reachable. */
let runnerReplaced = false
let personInControl: PersonInControl = () => false

/** Replace the runner (tests), or with null restore the connector one. */
export function setAgentPageRunner(next: AgentPageRunner | null): void {
  runner = next ?? connectorRunner
  runnerReplaced = next !== null
}

/** Register how to tell that a person holds an agent's browser (take over). The
 *  fill never runs while they do. */
export function setPersonInControlCheck(next: PersonInControl | null): void {
  personInControl = next ?? (() => false)
}

export function runInAgentPage(
  owner: BrowserOwner,
  fn: string,
  args: readonly unknown[],
  expectedOrigin: string,
): Promise<PageRunResult> {
  return runner(owner, fn, args, expectedOrigin)
}

export function isPersonInControlOf(agentId: string): boolean {
  try {
    return personInControl(agentId)
  } catch {
    // Unsure means a person may be there: do not fill under them.
    return true
  }
}

/** Whether a browser connector is connected at all (the install-wide answer the
 *  Settings page shows). */
export function agentBrowserFillAvailable(): boolean {
  if (runnerReplaced) return true
  return ['playwright', 'chrome-devtools'].some(
    (slug) => getLiveConnector(connectorInstanceIdForSlug(slug)) !== null,
  )
}

/** Whether this agent holds a live browser connector the fill can use, so the tool
 *  is worth offering it. */
export function agentBrowserFillAvailableFor(owner: BrowserOwner): boolean {
  if (runnerReplaced) return true
  return (
    typeof browserAccess('playwright', RUN_CODE_TOOL, owner) === 'object' ||
    typeof browserAccess('chrome-devtools', EVALUATE_TOOL, owner) === 'object'
  )
}
