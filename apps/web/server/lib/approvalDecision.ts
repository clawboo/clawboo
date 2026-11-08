// One answer to a pending approval, whichever route it arrives on.
//
// Two kinds of approval, released two different ways. A `tool` approval is held
// by THIS process: a promise blocked inside `waitForApproval`, which
// `resolveApproval` releases. An `exec` approval is held by the GATEWAY, and the
// only thing that releases it is `exec.approval.resolve`.
//
// Routing both down the local path would mark the card answered while the
// Gateway went on holding the command, with nothing on screen to reveal it.
// Dispatching on the stored `kind` is why that column is explicit rather than
// inferred. POST /api/tools/approvals/:id/resolve and POST
// /api/capabilities/approve both answer through here, so neither can skip it.

import { isAccountPerson } from '@clawboo/board-core'
import { resolveApproval, toolCallApprovals, type ClawbooDb, type PersonRecord } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { getRegistry } from './agentSource'
import { resolveExecApproval } from './agentSource/execApprovalSurface'

export type ApprovalDecision = 'allow_once' | 'allow_always' | 'deny'

/** The error an "Allow always" from an app link's person gets. */
export const ALLOW_ALWAYS_FROM_APP = 'allow_always_from_app'

/** The HTTP status and body a route sends back. */
export interface ApprovalAnswer {
  status: number
  body: Record<string, unknown>
}

/** `resolvedBy` is the person a sign-in proxy vouched for, recorded on the
 *  approval with the answer; null records it with no name. */
export async function decideApproval(
  db: ClawbooDb,
  id: string,
  decision: ApprovalDecision,
  opts: { resolvedBy?: PersonRecord | null } = {},
): Promise<ApprovalAnswer> {
  // An app link answers for its people from another device, with a key that
  // lives on this computer. It may allow once or deny, never mint a standing
  // rule: an "Always" signed with a stolen key would outlast every card the
  // person ever saw. Refused before anything is read or released.
  if (decision === 'allow_always' && isAccountPerson(opts.resolvedBy?.id)) {
    return {
      status: 403,
      body: {
        error: ALLOW_ALWAYS_FROM_APP,
        message: 'An answer from the app that started Clawboo can allow once or deny.',
      },
    }
  }
  const row = db
    .select({ kind: toolCallApprovals.kind })
    .from(toolCallApprovals)
    .where(eq(toolCallApprovals.id, id))
    .get()
  if (!row) return { status: 404, body: { error: 'approval not found' } }

  if (row.kind === 'exec') {
    // OpenClaw's own vocabulary. Its allow-always writes ITS allowlist, which
    // is the only place a durable exec grant can live.
    const gatewayDecision =
      decision === 'deny' ? 'deny' : decision === 'allow_always' ? 'allow-always' : 'allow-once'
    const out = await resolveExecApproval(getRegistry().source, id, gatewayDecision, opts)
    if (!out.ok) {
      return { status: 502, body: { error: 'the Gateway did not accept that decision' } }
    }
    // `alreadyResolved` is a normal race, not a failure: the same card is
    // deliberately open in the browser tab too.
    return {
      status: 200,
      body: { ok: true, kind: 'exec', alreadyResolved: out.alreadyResolved ?? false },
    }
  }

  const updated = resolveApproval(db, id, decision, opts)
  if (!updated) return { status: 404, body: { error: 'approval not found' } }
  // A card past its deadline takes no answer, so this one counted for nothing.
  // `pending` here means the card could not be marked expired; it is closed all
  // the same.
  if (updated.status === 'expired' || updated.status === 'pending') {
    return { status: 409, body: { error: 'approval expired', approval: updated } }
  }
  return { status: 200, body: { ok: true, approval: updated } }
}
