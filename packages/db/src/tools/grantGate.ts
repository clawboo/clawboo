// The grant gate: where a `capability_grants` row stops being decorative.
//
// WHAT IS GOVERNED, and why the line falls where it does. A call is
// grant-governed only when its descriptor is NOT owner:'core' AND the caller
// supplied a `connectorId`. That is exactly the pair a connected connector
// produces, so from the moment one is connected this gate decides every call to
// its tools. Core builtins stay ungoverned: they are clawboo's own verbs, and a
// grant that could revoke them would be a switch for turning the product off.
//
// The alternative -- gating everything and back-filling permissive grants -- was
// rejected. A permissive back-fill that authorizes everything is indistinguishable
// from no gate at all, right up until the day someone tightens it and discovers
// which calls it was silently carrying.

import {
  decideGrant,
  type GrantDecision,
  type GrantToolFacts,
  type StandingRule,
} from '@clawboo/governance'

import type { ClawbooDb } from '../db'
import { callsInWindow, chargeCall, releaseCall } from '../grants/rateWindow'
import { listCandidateGrants, listStandingRules } from '../grants/repository'
import { brokeredMetaToolKind } from './brokeredApp'
import { getConnector } from '../grants/connectors'
import type { ToolCallContext, ToolDescriptor } from './types'

export interface GrantGateResult {
  decision: GrantDecision
  connectorId: string
  /** Whether a charge is currently held against the rate window for this call.
   *  Mutable: the approval path charges after the human answers, and every path
   *  releases if the call ends up not running. */
  charged: boolean
}

/** Everything `decideGrant` needs to know about the tool, from the descriptor. */
export function toolFacts(descriptor: ToolDescriptor): GrantToolFacts {
  return {
    name: descriptor.name,
    readOnly: descriptor.readOnly,
    destructive: descriptor.destructive,
    idempotent: descriptor.idempotent,
    openWorld: descriptor.openWorld,
    risk: descriptor.risk,
    trifecta: descriptor.trifecta,
    neverRemember: descriptor.neverRemember,
  }
}

/**
 * Decide whether this call is authorized, or `null` when no grant governs it.
 *
 * `null` is NOT "allowed": it means the question does not apply, and the caller
 * proceeds down the pre-existing pipeline unchanged. A grant-governed call that
 * finds no row gets a real `deny: no-grant` instead.
 *
 * The rate window is read and charged in ONE synchronous block with the
 * decision. `decideGrant` is pure and synchronous precisely so that is possible:
 * with an await in between, concurrent callers all observe zero and a ceiling
 * of N admits arbitrarily many calls.
 */
/**
 * Whether the grant gate governs this call at all.
 *
 * THE BOUNDARY, NAMED ONCE. A builtin is core and ungoverned by design, and a
 * descriptor with no connector has no grant to find. The tool LISTER asks the
 * same question, and two spellings of it would let the list and the gate
 * disagree about which tools are even in scope.
 */
export function isGrantGoverned(descriptor: ToolDescriptor, connectorId: string | null): boolean {
  if (descriptor.owner === 'core' || descriptor.owner === undefined) return false
  if (connectorId === null) return false
  // A BROKER'S TRANSPORT IS NOT ITSELF A CAPABILITY. Its app-facing meta-tools
  // reach nothing until a per-app grant says so (see `brokeredAppGap` in
  // broker.ts), so governing them here as well would mean an app grant did
  // nothing without a session grant beside it, and the operator would have to
  // authorize a layer that carries no authority. The broker's unscoped tools,
  // a remote shell and a sandbox, are NOT excused: nothing per-app can bound
  // them, so they stay here where they can be allowed or denied by name.
  if (brokeredMetaToolKind(descriptor.name) === 'app-facing') return false
  return true
}

export function evaluateGrant(
  db: ClawbooDb,
  descriptor: ToolDescriptor,
  ctx: ToolCallContext,
  now = Date.now(),
): GrantGateResult | null {
  const connectorId = ctx.connectorId ?? null
  // The null test is repeated rather than left to `isGrantGoverned`, which
  // shares the rule with the tool lister but whose boolean return narrows
  // nothing here.
  if (connectorId === null || !isGrantGoverned(descriptor, connectorId)) return null

  const grants = listCandidateGrants(db, {
    agentId: ctx.agentId ?? null,
    teamId: ctx.teamId ?? null,
    connectorId,
  })

  // Live hashes, so the gate can see drift. Null until an outbound MCP client
  // writes a `connectors` row, and `decideGrant` skips the comparison on null
  // rather than treating "unknown" as "changed".
  const connector = getConnector(db, connectorId)

  // First pass picks the grant, so the rate window can be read for THAT grant.
  const chosen = decideGrant({ grants, tool: toolFacts(descriptor), now })
  if (chosen.grantId === null) {
    return { decision: chosen, connectorId, charged: false }
  }

  const rules: StandingRule[] = listStandingRules(db, chosen.grantId)
  const decision = decideGrant({
    grants,
    tool: toolFacts(descriptor),
    currentSpecHash: connector?.specHash ?? null,
    currentToolsHash: connector?.toolsHash ?? null,
    callsInWindow: callsInWindow(chosen.grantId, now),
    standingRules: rules,
    // Always null in this release: nothing in the repo computes an args-shape
    // hash, so every standing rule is an any-args rule. A merely type-shaped
    // hash would be WORSE than none, because it turns one fatigued "Always"
    // click into a permanent any-path authorization.
    argsShape: null,
    runTrifecta: ctx.runTrifecta,
    tainted: ctx.tainted,
    now,
  })

  // Charge here, still synchronously, for a verdict that leads straight to a
  // call. An approval-gated call is charged LATER, once a human says yes, by
  // `chargeGrantCall` -- charging on the prompt would bill a call that may never
  // run, and not charging at all would let a grant that combines an approval
  // policy with a ceiling exceed that ceiling indefinitely.
  const charged = decision.kind === 'allow'
  if (charged) chargeCall(chosen.grantId, now)

  return { decision, connectorId, charged }
}

/**
 * Charge a call that proceeded after a human approved it.
 *
 * Idempotent through `charged`: a result already charged at decision time is
 * left alone, so no call is ever counted twice.
 */
export function chargeGrantCall(result: GrantGateResult | null, now = Date.now()): void {
  if (!result || result.charged || !result.decision.grantId) return
  chargeCall(result.decision.grantId, now)
  result.charged = true
}

/** Give back a charge when the call it was taken for never ran. */
export function releaseGrantCharge(result: GrantGateResult | null, now = Date.now()): void {
  if (!result?.charged || !result.decision.grantId) return
  releaseCall(result.decision.grantId, now)
  result.charged = false
}

/** The standing rule id a decision short-circuited on, for the audit row. */
export function ruleIdOf(decision: GrantDecision): string | null {
  return decision.kind === 'allow' ? (decision.ruleId ?? null) : null
}
