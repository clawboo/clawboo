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
//   login's origin.
// - Chrome DevTools (`evaluate_script`): the page function checks
//   `location.origin` itself, in the same task that fills.
//
// The values travel in the call's arguments to the connector process, which runs
// as the agent user when agents run as their own user: the same exposure as the
// value once it is in the page. Playwright echoes the code back in its answer;
// only the result is read from it and the rest is dropped here.

import { getDb } from '../db'
import { isToolVisibleToAgent } from '@clawboo/db'

import { connectorInstanceIdForSlug } from '../capabilitySource/connectorIdentity'
import { callIfRunning } from '../connectors/agentBrowsers'
import { getLiveConnector } from '../connectors/supervisor'

/** What a page function run in the agent's current tab gave back. */
export interface PageRun {
  /** The main frame's address, as the browser reports it, when the backend can
   *  say. Null when it cannot (the function then checks the origin itself). */
  frameUrl: string | null
  /** The function's JSON result, or undefined when it was not run (the main frame
   *  was not on the expected origin) or its answer could not be read. */
  value: unknown
}

/**
 * Run `fn` (a function's source, called with `args`) in the main frame of the
 * agent's current tab. `expectedOrigin` lets a backend that can read the frame's
 * address skip a page on another origin without evaluating anything there. Null
 * when the agent has no browser open. Never starts one.
 */
export type AgentPageRunner = (
  agentId: string,
  fn: string,
  args: readonly unknown[],
  expectedOrigin: string,
) => Promise<PageRun | null>

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

/** The Playwright code for one run. The frame's address comes from Playwright's own
 *  state, so a page cannot fake it, and nothing is evaluated off the origin.
 *
 *  Playwright runs it in a bare `vm` context with only `page` in scope: no
 *  `URL`, no Node globals. So the origin test is on the browser's canonical
 *  address (lower-case host, default port dropped, punycode): it must be the origin
 *  itself or the origin followed by `/`, `?` or `#`, which a longer host, a
 *  port or a userinfo trick never is. */
export function playwrightCode(
  fn: string,
  args: readonly unknown[],
  expectedOrigin: string,
): string {
  return `async (page) => {
  const frame = page.mainFrame()
  const frameUrl = frame.url()
  const origin = ${JSON.stringify(expectedOrigin)}
  const onOrigin = frameUrl === origin || ['/', '?', '#'].some((c) => frameUrl.startsWith(origin + c))
  if (!onOrigin) return { frameUrl, ran: false }
  return { frameUrl, ran: true, value: await frame.evaluate(${JSON.stringify(callExpression(fn, args))}) }
}`
}

/** The result section of a Playwright MCP answer: `### Result` up to the next heading. */
export function playwrightResult(text: string): PageRun | null {
  const at = text.indexOf('### Result\n')
  if (at < 0) return null
  const rest = text.slice(at + '### Result\n'.length)
  const end = rest.indexOf('\n### ')
  const body = (end < 0 ? rest : rest.slice(0, end)).trim()
  try {
    const parsed = JSON.parse(body) as { frameUrl?: unknown; ran?: unknown; value?: unknown }
    return {
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
    return { frameUrl: null, value: JSON.parse(m[1] as string) as unknown }
  } catch {
    return null
  }
}

/** The raw tool on a live browser connector this agent was given, or null. */
function grantedRawTool(slug: string, rawName: string, agentId: string): string | null {
  const connectorId = connectorInstanceIdForSlug(slug)
  const live = getLiveConnector(connectorId)
  if (!live) return null
  // The agent's own grant decides, as for the browser panel: a browser it was
  // taken away from is not one the fill reaches.
  const any = live.descriptors.find((d) => live.rawToolNames.get(d.name) === rawName)
  if (!any || !isToolVisibleToAgent(getDb(), any, { agentId, connectorId })) return null
  return connectorId
}

/** The runner over the two browser connectors, Playwright first. */
const connectorRunner: AgentPageRunner = async (agentId, fn, args, expectedOrigin) => {
  const playwright = grantedRawTool('playwright', RUN_CODE_TOOL, agentId)
  if (playwright) {
    const res = await callIfRunning(playwright, agentId, RUN_CODE_TOOL, {
      code: playwrightCode(fn, args, expectedOrigin),
    })
    if (res) return playwrightResult(res.text) ?? { frameUrl: null, value: undefined }
  }
  const devtools = grantedRawTool('chrome-devtools', EVALUATE_TOOL, agentId)
  if (devtools) {
    const res = await callIfRunning(devtools, agentId, EVALUATE_TOOL, {
      function: `() => ${callExpression(fn, args)}`,
    })
    if (res) return devtoolsResult(res.text) ?? { frameUrl: null, value: undefined }
  }
  return null
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
  agentId: string,
  fn: string,
  args: readonly unknown[],
  expectedOrigin: string,
): Promise<PageRun | null> {
  return runner(agentId, fn, args, expectedOrigin)
}

export function isPersonInControlOf(agentId: string): boolean {
  try {
    return personInControl(agentId)
  } catch {
    // Unsure means a person may be there: do not fill under them.
    return true
  }
}

/** Whether a browser connector is connected at all, so a fill could reach an
 *  agent's browser once it has one open. */
export function agentBrowserFillAvailable(): boolean {
  if (runnerReplaced) return true
  return ['playwright', 'chrome-devtools'].some(
    (slug) => getLiveConnector(connectorInstanceIdForSlug(slug)) !== null,
  )
}
