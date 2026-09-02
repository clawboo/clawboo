// Would a call to this tool clear the grant gate? Asked at LIST time.
//
// WHY A SECOND CONSUMER OF decideGrant RATHER THAN A SECOND RULE. A list built
// from `state === 'active'`, or from any other hand-rolled approximation, would
// advertise tools the gate then refuses, which is the failure the grant spine
// exists to make impossible. So this asks the SAME function over the SAME
// candidate rows and differs only in what it does with the answer.
//
// IT CHARGES NOTHING AND RECORDS NOTHING. `evaluateGrant` bills the rate window
// on every allow and its caller emits a governance decision. Reusing it here
// would bill one call per connector tool per `tools/list`, and a native run
// re-derives its tool universe at every turn boundary: a grant with a ceiling
// would be exhausted before the model called anything, and the audit log would
// fill with denials for calls nobody made.
//
// THE RATE WINDOW IS DELIBERATELY NOT CONSULTED. A tool the agent has been
// granted but has called too often this hour is limited, not ungranted. Hiding
// it would make the tool list flicker in and out under load, and the model
// would be told a capability had ceased to exist when it had merely paused.
//
// AN APPROVAL IS NOT A REFUSAL. Only a `deny` hides a tool. A tool that would
// prompt a human is exactly the tool the model must still be able to reach, or
// the approval flow becomes unreachable and the human is never asked.

import { decideGrant } from '@clawboo/governance'

import type { ClawbooDb } from '../db'
import { getConnector } from '../grants/connectors'
import { listCandidateGrants } from '../grants/repository'
import { brokeredAppConnectorId } from './brokeredApp'
import { isGrantGoverned, toolFacts } from './grantGate'
import type { ToolDescriptor } from './types'

export interface ToolVisibilityContext {
  agentId?: string | null
  teamId?: string | null
  /** The connector this tool came from, or null for a builtin. */
  connectorId?: string | null
}

/**
 * Whether this agent may see this tool at all.
 *
 * True for everything the gate does not govern, so builtins are unaffected and
 * a caller can run this over the whole registry without special-casing.
 */
export function isToolVisibleToAgent(
  db: ClawbooDb,
  descriptor: ToolDescriptor,
  ctx: ToolVisibilityContext,
  now = Date.now(),
): boolean {
  const connectorId = ctx.connectorId ?? null
  // Narrowed here rather than leaning on `isGrantGoverned`: that predicate is
  // shared with the gate and its return type says nothing about this variable.
  if (connectorId === null || !isGrantGoverned(descriptor, connectorId)) return true

  const grants = listCandidateGrants(db, {
    agentId: ctx.agentId ?? null,
    teamId: ctx.teamId ?? null,
    connectorId,
  })

  // The same drift inputs the gate uses, so a tool whose server changed under a
  // pinned grant disappears from the list rather than being offered and refused.
  const connector = getConnector(db, connectorId)
  const decision = decideGrant({
    grants,
    tool: toolFacts(descriptor),
    currentSpecHash: connector?.specHash ?? null,
    currentToolsHash: connector?.toolsHash ?? null,
    now,
  })

  return decision.kind !== 'deny'
}

/**
 * The broker apps this agent has actually been granted.
 *
 * WHY THE TOOL LIST NEEDS THIS. A broker's meta-tools are named for the broker,
 * not for what they reach: an agent granted Gmail sees seven tools called
 * `COMPOSIO_*` and nothing anywhere saying the word Gmail. Asked to check email
 * it answered, correctly for what it could see, that it had Composio connected
 * but no email service. The grant was real and the agent could not know.
 *
 * Returned as the broker's own toolkit slugs, which is what its tool slugs are
 * prefixed with, so naming them is directly actionable: an agent told `GMAIL` can
 * go looking for `GMAIL_FETCH_EMAILS`.
 */
export function grantedBrokeredToolkits(
  db: ClawbooDb,
  connectorId: string,
  ctx: ToolVisibilityContext,
  known: readonly string[],
): string[] {
  const out: string[] = []
  for (const toolkit of known) {
    const grants = listCandidateGrants(db, {
      agentId: ctx.agentId ?? null,
      teamId: ctx.teamId ?? null,
      connectorId: brokeredAppConnectorId(connectorId, toolkit),
    })
    // ACTIVE ONLY, for the same reason the per-app gate filters: these rows
    // arrive unfiltered by state, and naming an app whose grant was revoked
    // would advertise access the gate then refuses.
    if (grants.some((g) => g.state === 'active')) out.push(toolkit)
  }
  return out
}
