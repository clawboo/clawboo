// ─── Per-call inspector chain ───────────────────────────────────────────────
// Each inspector returns Allow | Deny | RequireApproval | RewriteArgs. The chain
// short-circuits on the first deny/require_approval; a rewrite mutates the args
// and continues. Order: deny-gates (security, scope) → rewrite (clamp) →
// approval-gate (risk) LAST, so a denied call never reaches the approval prompt.

import { scanForInjection } from './injection'
import type { ChainOutcome, Inspector, InspectorDecision, ToolCall } from './types'

/** SECURITY — hard-deny calls whose args carry malicious / destructive content. */
export const securityInspector: Inspector = (call): InspectorDecision => {
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
  if (blocking) return { kind: 'deny', reason: `security:${blocking.severity}:${blocking.pattern}` }
  return { kind: 'allow' }
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
export const riskClassifierInspector: Inspector = (_call, descriptor): InspectorDecision => {
  if (descriptor.risk === 'destructive') {
    return {
      kind: 'require_approval',
      message: `"${descriptor.name}" is destructive and needs approval.`,
    }
  }
  if (descriptor.risk === 'external') {
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
  for (const inspect of inspectors) {
    const decision = await inspect({ name: call.name, args }, descriptor, ctx)
    if (decision.kind === 'deny') return { decision: 'deny', reason: decision.reason }
    if (decision.kind === 'require_approval') {
      return { decision: 'require_approval', message: decision.message, args }
    }
    if (decision.kind === 'rewrite') Object.assign(args, decision.args)
    // 'allow' → continue
  }
  return { decision: 'allow', args }
}
