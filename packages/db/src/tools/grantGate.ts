// The grant gate — where a `capability_grants` row stops being decorative.
//
// WHAT IS GOVERNED, and why the answer is narrow today. A call is grant-governed
// only when its descriptor is NOT owner:'core' AND the caller supplied a
// `connectorId`. Every tool reachable today is a core builtin, so this gate is
// inert in this release BY CONSTRUCTION rather than by accident: it cannot
// change the behaviour of a single call that works right now, and it is already
// the real enforcement path the moment a connector's own tools are registered.
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
import { getConnector } from '../grants/connectors'
import type { ToolCallContext, ToolDescriptor } from './types'

export interface GrantGateResult {
  decision: GrantDecision
  connectorId: string
  /** Charge taken against the rate window, to be released if the call never runs. */
  charged: boolean
}

/** Everything `decideGrant` needs to know about the tool, from the descriptor. */
function toolFacts(descriptor: ToolDescriptor): GrantToolFacts {
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
export function evaluateGrant(
  db: ClawbooDb,
  descriptor: ToolDescriptor,
  ctx: ToolCallContext,
  now = Date.now(),
): GrantGateResult | null {
  if (descriptor.owner === 'core' || descriptor.owner === undefined) return null
  const connectorId = ctx.connectorId ?? null
  if (connectorId === null) return null

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

  // Charge here, still synchronously, and only for a verdict that leads to a
  // call actually running.
  const charged = decision.kind === 'allow'
  if (charged) chargeCall(chosen.grantId, now)

  return { decision, connectorId, charged }
}

/** Give back a charge when the call it was taken for never ran. */
export function releaseGrantCharge(result: GrantGateResult | null, now = Date.now()): void {
  if (result?.charged && result.decision.grantId) releaseCall(result.decision.grantId, now)
}

/** The standing rule id a decision short-circuited on, for the audit row. */
export function ruleIdOf(decision: GrantDecision): string | null {
  return decision.kind === 'allow' ? (decision.ruleId ?? null) : null
}
