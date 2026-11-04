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

import { resolveApproval, toolCallApprovals, type ClawbooDb } from '@clawboo/db'
import { eq } from 'drizzle-orm'

import { getRegistry } from './agentSource'
import { resolveExecApproval } from './agentSource/execApprovalSurface'

export type ApprovalDecision = 'allow_once' | 'allow_always' | 'deny'

/** The HTTP status and body a route sends back. */
export interface ApprovalAnswer {
  status: number
  body: Record<string, unknown>
}

export async function decideApproval(
  db: ClawbooDb,
  id: string,
  decision: ApprovalDecision,
): Promise<ApprovalAnswer> {
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
    const out = await resolveExecApproval(getRegistry().source, id, gatewayDecision)
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

  const updated = resolveApproval(db, id, decision)
  if (!updated) return { status: 404, body: { error: 'approval not found' } }
  // A card past its deadline takes no answer, so this one counted for nothing.
  // `pending` here means the card could not be marked expired; it is closed all
  // the same.
  if (updated.status === 'expired' || updated.status === 'pending') {
    return { status: 409, body: { error: 'approval expired', approval: updated } }
  }
  return { status: 200, body: { ok: true, approval: updated } }
}
