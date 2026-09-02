// ─── Per-call inspector chain ───────────────────────────────────────────────
// Each inspector returns Allow | Deny | RequireApproval | RewriteArgs. The chain
// short-circuits on the first deny/require_approval; a rewrite mutates the args
// and continues. Order: deny-gates (security, scope) → rewrite (clamp) →
// approval-gate (risk) LAST, so a denied call never reaches the approval prompt.

import { scanForInjection } from './injection'
import type { ChainOutcome, Inspector, InspectorDecision, ToolCall, ToolDescriptor } from './types'

/**
 * SECURITY — deny calls whose args carry malicious content.
 *
 * `scanForInjection` was written for a different job: its own header says it
 * scans "a user-installed skill's text … before it can register or run", where
 * every byte is about to be EXECUTED. Reusing it verbatim on arbitrary tool args
 * imported an assumption that does not hold — a tool argument is not a program,
 * and whether a destructive string in one matters depends entirely on what the
 * tool does with it.
 *
 * The consequence was live and reachable: `echo { message: 'reminder: never run
 * rm -rf / on the server' }` came back
 * `denied: security:destructive:recursive-delete-root`. An agent could not
 * discuss a destructive command with its teammates, and the denial is not free —
 * the native conversation surfaces a brokered denial as `policy_denied`, which the
 * circuit breaker counts, so talking about the work moved the agent toward a
 * tripped breaker.
 *
 * The split:
 *   • `destructive` / `exfil` attack the MACHINE, and need something to run them.
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
  const findings = scanForInjection(blob)
  const blocking = findings.find(
    (f) => f.severity === 'destructive' || f.severity === 'exfil' || f.severity === 'injection',
  )
  if (!blocking) return { kind: 'allow' }
  const reason = `security:${blocking.severity}:${blocking.pattern}`
  const isMention = descriptor?.risk === 'safe' && blocking.severity !== 'injection'
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

/**
 * A read the catalog vouches for, on a connector that touches no private data.
 *
 * `risk` is a CONNECTOR-level floor: `canEgress` makes every tool on a browser
 * connector `external`, including the ones that only look at the page. Left
 * there, the gate fires on `browser_snapshot` exactly as hard as on
 * `browser_click`, so a single page visit costs several modal clicks and users
 * learn to rubber-stamp the prompts that actually matter.
 *
 * `readOnly` is safe to lean on precisely because it is not the server's own
 * word: `buildConnectorDescriptor` only copies `readOnlyHint` through when the
 * connector is CURATED, so the trust comes from the catalog vouching for the
 * package. An unannotated or community tool never reaches this branch.
 *
 * `readsPrivateData` still prompts. For a browser the read is a public page and
 * the risk is what it does next; for a connector holding the user's own records
 * the read IS the sensitive act, so it keeps its gate.
 */
function isVouchedRead(descriptor: ToolDescriptor): boolean {
  return descriptor.readOnly === true && descriptor.trifecta?.readsPrivateData !== true
}

/** RISK — destructive/external tools require human approval (risk-classified, so
 *  only these prompt — safe tools run unattended). */
export const riskClassifierInspector: Inspector = (_call, descriptor): InspectorDecision => {
  // An explicit destructive annotation prompts whatever the connector-level
  // risk floor says, and outranks a contradictory `readOnly` on the same tool.
  if (descriptor.risk === 'destructive' || descriptor.destructive === true) {
    return {
      kind: 'require_approval',
      message: `"${descriptor.name}" is destructive and needs approval.`,
    }
  }
  if (descriptor.risk === 'external' && !isVouchedRead(descriptor)) {
    return {
      kind: 'require_approval',
      message: `"${descriptor.name}" has external side effects and needs approval.`,
    }
  }
  return { kind: 'allow' }
}

export const defaultInspectors: Inspector[] = [
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
