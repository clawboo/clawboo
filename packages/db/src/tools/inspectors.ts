// ─── Per-call inspector chain ───────────────────────────────────────────────
// Each inspector returns Allow | Deny | RequireApproval | RewriteArgs. The chain
// short-circuits on the first deny/require_approval; a rewrite mutates the args
// and continues. Order: deny-gates (security, scope) → rewrite (clamp) →
// approval-gate (risk) LAST, so a denied call never reaches the approval prompt.

import { evaluateInjection } from './injection'
import type { ChainOutcome, Inspector, InspectorDecision, ToolCall } from './types'

/**
 * SECURITY — deny calls whose args carry malicious content.
 *
 * Tool args are evaluated on the `exec` surface: they are spawn/args-bound, so
 * every rule that fires is a blocking finding by the policy matrix, including
 * `supply-chain` (an `npm install https://…` in a tool argument is the attack,
 * not documentation; the original scan skipped that severity entirely).
 *
 * The scanner was written for a different job: it scans "a user-installed
 * skill's text … before it can register or run", where every byte is about to be
 * EXECUTED. Reusing it verbatim on arbitrary tool args imported an assumption
 * that does not hold: a tool argument is not a program, and whether a
 * destructive string in one matters depends entirely on what the tool does with
 * it.
 *
 * The consequence was live and reachable: `echo { message: 'reminder: never run
 * rm -rf / on the server' }` came back
 * `denied: security:destructive:recursive-delete-root`. An agent could not
 * discuss a destructive command with its teammates, and the denial is not free —
 * the native conversation surfaces a brokered denial as `policy_denied`, which the
 * circuit breaker counts, so talking about the work moved the agent toward a
 * tripped breaker.
 *
 * The split (the policy's `intent` axis, applied here as the mention carve-out):
 *   • `destructive` / `exfil` / `supply-chain` attack the MACHINE, and need
 *     something to run them.
 *     On a tool that declares `risk: 'safe'` — no side effects, by the descriptor's
 *     own assertion — nothing can. Those are MENTIONS, so they are observed rather
 *     than denied.
 *   • `injection` attacks the MODEL, and content IS the vector: `note` writes to
 *     memory that is injected into a later prompt. Unchanged, on every tool.
 *   • Anything not explicitly `risk: 'safe'` — including a descriptor that declares
 *     no risk at all — is unchanged. Fail closed on the ones we cannot vouch for.
 *
 * ⚠ THIS IS A SPEED BUMP, NOT A SECURITY BOUNDARY. It matches literal strings, so
 * a single backslash walks past it: `r\m -rf /` is permitted today and still is.
 * Normalizing away that obfuscation is real work with real false-positive risk,
 * and it is worth doing only once clawboo has an exec-style tool for it to guard —
 * there is none today.
 */
export const securityInspector: Inspector = (call, descriptor): InspectorDecision => {
  let blob = ''
  try {
    blob = JSON.stringify(call.args)
  } catch {
    blob = String(call.args)
  }
  const blocking = evaluateInjection(blob, { surface: 'exec', scope: `tool:${call.name}` }).block[0]
  if (!blocking) return { kind: 'allow' }
  // Unchanged wire format: tests assert `security:destructive:drop-table`.
  const reason = `security:${blocking.severity}:${blocking.pattern}`
  const isMention = descriptor?.risk === 'safe' && blocking.intent !== 'language'
  return isMention ? { kind: 'observe', reason: `mention:${reason}` } : { kind: 'deny', reason }
}

/** SCOPE — deny tools on the caller's blocklist (e.g. delegation primitives a
 *  child run must not use). */
export const scopeInspector: Inspector = (call, _descriptor, ctx): InspectorDecision => {
  if (ctx.toolBlocklist?.includes(call.name)) {
    return { kind: 'deny', reason: `scope:blocked-for-caller:${call.name}` }
  }
  return { kind: 'allow' }
}

const CLAMP_KEYS = ['limit', 'max', 'count', 'maxResults', 'top_k', 'topK']
const CLAMP_MAX = 1_000

/** REWRITE example — clamp unbounded numeric args (silent, no transcript edit). */
export const argClampInspector: Inspector = (call): InspectorDecision => {
  let rewrote = false
  const next = { ...call.args }
  for (const k of CLAMP_KEYS) {
    const v = next[k]
    if (typeof v === 'number' && v > CLAMP_MAX) {
      next[k] = CLAMP_MAX
      rewrote = true
    }
  }
  return rewrote ? { kind: 'rewrite', args: next } : { kind: 'allow' }
}

/** RISK — destructive/external tools require human approval (risk-classified, so
 *  only these prompt — safe tools run unattended). */
export const riskClassifierInspector: Inspector = (_call, descriptor, ctx): InspectorDecision => {
  // An explicit destructive annotation prompts whatever the connector-level
  // risk floor says, and outranks a contradictory `readOnly` on the same tool.
  if (descriptor.risk === 'destructive' || descriptor.destructive === true) {
    return {
      kind: 'require_approval',
      message: `"${descriptor.name}" is destructive and needs approval.`,
    }
  }
  // EXTERNAL AND MUTATING, which is the rule the grant layer already applies
  // (governance/grants/decide.ts: `risk === 'external' && isMutating(tool)`).
  // This asked about every external call, read-only ones included, so a broker's
  // catalogue SEARCH prompted exactly as loudly as a send. The message names
  // "side effects", which a read-only tool does not have, and the practical
  // result was an agent waiting on an approval nobody was watching for and then
  // reporting the timeout as a service outage.
  //
  // A standing "Always" rule answers this one. The operator was shown this
  // external change and asked not to be asked again; asking anyway made the
  // card's 30-day box do nothing. Destructive calls above never get this pass.
  if (
    descriptor.risk === 'external' &&
    descriptor.readOnly !== true &&
    ctx?.rememberedAllow !== true
  ) {
    return {
      kind: 'require_approval',
      message: `"${descriptor.name}" has external side effects and needs approval.`,
    }
  }
  return { kind: 'allow' }
}

// ─── The dashboard ───────────────────────────────────────────────────────────

let dashboardPorts: ReadonlySet<number> = new Set()
let dashboardHosts: ReadonlySet<string> = new Set()

/** A host as the URL parser writes it, without a trailing dot, or null. */
function canonicalHost(host: string): string | null {
  const raw = host.trim()
  if (!raw) return null
  try {
    const bracketed = raw.includes(':') && !raw.startsWith('[') ? `[${raw}]` : raw
    return new URL(`http://${bracketed}`).hostname.replace(/\.$/, '')
  } catch {
    return null
  }
}

/** The ports the Clawboo dashboard listens on, and the address it is bound to
 *  (`HOST`), which counts as the dashboard on those ports even when it is not
 *  a loopback address. The server sets them at boot. */
export function setDashboardPorts(ports: readonly number[], hosts: readonly string[] = []): void {
  dashboardPorts = new Set(ports)
  dashboardHosts = new Set(hosts.flatMap((host) => canonicalHost(host) ?? []))
}

const isLoopbackHost = (host: string): boolean => {
  const h = host.toLowerCase().replace(/\.$/, '')
  return (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    /^127\./.test(h) ||
    h === '0.0.0.0' ||
    h === '[::1]' ||
    h === '[::]' ||
    h === '[::ffff:0:0]' ||
    /^\[::ffff:(127\.|7f)/.test(h)
  )
}

// A host with an explicit port, with or without a scheme in front of it. A match
// may only start where a host can start (the lookbehind), so a long run of host
// characters with no port is read in linear time. The host is not length-capped:
// a cap would let an over-long `*.localhost` name slip past unmatched. It takes
// percent escapes and non-ASCII characters, which the URL parser turns into a
// plain name (`%6c%6fcalhost`, and localhost in full-width letters, are
// localhost), and a port of any length, because `:018790` is still port 18790.
const HOST_PORT = /(?<![a-z0-9.%\u0080-\uffff-])(\[[0-9a-f:.]+\]|[a-z0-9.%\u0080-\uffff-]+):(\d+)/gi

/** The plain-ASCII name at the end of a run, as a stricter reader takes it. */
function asciiTail(run: string): string {
  let i = run.length
  while (i > 0 && /[a-z0-9.-]/i.test(run[i - 1]!)) i--
  return run.slice(i)
}

const opensDashboard = (host: string, port: string): boolean => {
  try {
    const hostname = new URL(`http://${host}:${port}`).hostname
    return isLoopbackHost(hostname) || dashboardHosts.has(hostname.replace(/\.$/, ''))
  } catch {
    return false // Not a host this browser could open.
  }
}

function scanForDashboard(text: string): boolean {
  for (const m of text.matchAll(HOST_PORT)) {
    const host = m[1]!
    const port = m[2]!
    if (!dashboardPorts.has(Number(port))) continue
    if (opensDashboard(host, port)) return true
    const tail = asciiTail(host)
    if (tail && tail !== host && opensDashboard(tail, port)) return true
  }
  return false
}

/** Whether a string names a dashboard address. The host is parsed the way a
 *  browser parses it, so `2130706433` and `0x7f.1` read as 127.0.0.1. A URL
 *  parser also drops every tab and line break, so `local<tab>host` is read
 *  again without them. */
function namesDashboard(text: string): boolean {
  return (
    scanForDashboard(text) ||
    (/[\t\n\r]/.test(text) && scanForDashboard(text.replace(/[\t\n\r]/g, '')))
  )
}

function argsNameDashboard(value: unknown, depth = 0): boolean {
  if (depth > 6) return false
  if (typeof value === 'string') return namesDashboard(value)
  if (Array.isArray(value)) return value.some((v) => argsNameDashboard(v, depth + 1))
  if (value && typeof value === 'object')
    return Object.values(value).some((v) => argsNameDashboard(v, depth + 1))
  return false
}

/**
 * DENY a call that points at the Clawboo dashboard on this machine.
 *
 * The dashboard has no access check on loopback, so an agent driving a browser
 * there could approve its own requests or give itself connectors. The browser
 * connectors are launched with the dashboard blocked as well; this refuses the
 * call before it reaches them, and covers any other tool that takes a URL.
 * Not an approval: no person should be asked to let an agent operate the
 * dashboard, so there is nothing to remember either.
 */
export const dashboardInspector: Inspector = (call): InspectorDecision =>
  dashboardPorts.size > 0 && argsNameDashboard(call.args)
    ? { kind: 'deny', reason: 'dashboard:agents may not open the Clawboo dashboard' }
    : { kind: 'allow' }

export const defaultInspectors: Inspector[] = [
  dashboardInspector,
  securityInspector,
  scopeInspector,
  argClampInspector,
  riskClassifierInspector,
]

/**
 * Run the inspector chain. Returns the resolved outcome with the (possibly
 * rewritten) args. Deny / require_approval short-circuit; rewrites accumulate.
 */
export async function runInspectors(
  call: ToolCall,
  descriptor: Parameters<Inspector>[1],
  ctx: Parameters<Inspector>[2],
  inspectors: Inspector[] = defaultInspectors,
): Promise<ChainOutcome> {
  const args: Record<string, unknown> = { ...call.args }
  // What a stricter reading would have refused. Carried to the caller so the audit
  // row records it — an observation that only ever reached a local variable would
  // be indistinguishable from never having looked.
  const observations: string[] = []
  const withObs = <T extends object>(o: T): T =>
    observations.length > 0 ? { ...o, observations } : o
  for (const inspect of inspectors) {
    const decision = await inspect({ name: call.name, args }, descriptor, ctx)
    if (decision.kind === 'deny') return { decision: 'deny', reason: decision.reason }
    if (decision.kind === 'require_approval') {
      return withObs({ decision: 'require_approval' as const, message: decision.message, args })
    }
    if (decision.kind === 'rewrite') Object.assign(args, decision.args)
    if (decision.kind === 'observe') observations.push(decision.reason)
    // 'allow' → continue
  }
  return withObs({ decision: 'allow' as const, args })
}
