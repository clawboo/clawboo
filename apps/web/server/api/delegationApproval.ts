// ─── Delegation approval ───────────────────────────────
// Plumbs a delegated child's risky action back to the LEADER's approval queue.
// Reuses the existing DB-mediated `tool_call_approvals` handshake: a sticky
// `allow_always` for the (leader, scope) skips the prompt; otherwise it opens a
// pending approval (visible in the existing Approvals UI) and blocks until the
// leader resolves it OR the TTL/poll-deadline expires — so a forgotten approval
// TIMES OUT, never deadlocks.

import type { Request, Response } from 'express'

import {
  appendAudit,
  createApproval,
  createDb,
  priorAllowAlways,
  waitForApproval,
} from '@clawboo/db'

import { getDbPath } from '../lib/db'

// POST /api/governance/delegation-approval
// Body: { leaderAgentId, kind?, targetAgentName?, task? } → { resolution }
export async function delegationApprovalPOST(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>
  const leaderAgentId = typeof body['leaderAgentId'] === 'string' ? body['leaderAgentId'] : ''
  if (!leaderAgentId) {
    res.status(400).json({ error: 'leaderAgentId required' })
    return
  }
  const kind = typeof body['kind'] === 'string' && body['kind'] ? body['kind'] : 'code'
  const scopeKey = `delegate:${kind}`
  const task = typeof body['task'] === 'string' ? body['task'] : ''
  const targetAgentName =
    typeof body['targetAgentName'] === 'string' ? body['targetAgentName'] : undefined
  // The board task this delegation gates, when the caller supplies it — lets the
  // TTL reaper unblock the task if the approval is abandoned.
  const taskId = typeof body['taskId'] === 'string' ? body['taskId'] : null
  const db = createDb(getDbPath())

  // Sticky scope: a prior `allow_always` from this leader skips the prompt.
  if (priorAllowAlways(db, { agentId: leaderAgentId, scopeKey })) {
    appendAudit(db, {
      eventType: 'approval',
      agentId: leaderAgentId,
      summary: { scopeKey, resolution: 'allow_always', sticky: true },
    })
    res.json({ resolution: 'allow_always' })
    return
  }

  const approval = createApproval(db, {
    toolName: scopeKey,
    agentId: leaderAgentId,
    args: { task, targetAgentName },
    reason: `Delegation${targetAgentName ? ` to ${targetAgentName}` : ''}`,
    taskId,
  })
  const resolution = await waitForApproval(db, approval.id)
  appendAudit(db, {
    eventType: 'approval',
    agentId: leaderAgentId,
    summary: { scopeKey, resolution, approvalId: approval.id },
  })
  res.json({ resolution })
}
