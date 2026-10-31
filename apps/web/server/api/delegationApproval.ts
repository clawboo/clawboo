// ─── Delegation approval ───────────────────────────────
// Plumbs a delegated child's risky action back to the LEADER's approval queue.
// Reuses the existing DB-mediated `tool_call_approvals` handshake: every risky
// hand-off opens a pending approval (visible in the existing Approvals UI) and
// blocks until the leader resolves it OR the TTL/poll-deadline expires, so a
// forgotten approval TIMES OUT, never deadlocks. Nothing is remembered: an
// `allow_always` answer covers that one hand-off, exactly like `allow_once`,
// because nothing in the dashboard could list or revoke a remembered one.
//
// `resolveDelegationApproval` is the reusable core: the REST handler below AND the
// server team orchestrator (`teamOrchestrator.ts`, wired as the engine's
// `requestDelegationApproval` dep) both call it. It is FAIL-CLOSED — any DB /
// transport error resolves to `'timeout'`, which the engine treats as
// skip-and-reflect (never auto-run a risky delegation).

import type { Request, Response } from 'express'

import { appendAudit, createApproval, waitForApproval, type ClawbooDb } from '@clawboo/db'

import { getDb } from '../lib/db'

export type DelegationApprovalResolution =
  'allow_once' | 'allow_always' | 'deny' | 'expired' | 'timeout'

export interface ResolveDelegationApprovalInput {
  leaderAgentId: string
  targetAgentId?: string
  targetAgentName?: string
  task: string
  kind?: string
  /** The board task this delegation gates, when known — lets the TTL reaper unblock
   *  the task if the approval is abandoned. Unused by the engine wiring (the task is
   *  created AFTER the gate), so it's optional. */
  taskId?: string | null
}

/** Resolve a delegation approval (open + await). FAIL-CLOSED: any thrown error
 *  resolves to `'timeout'` (the engine skips + reflects). */
export async function resolveDelegationApproval(
  db: ClawbooDb,
  input: ResolveDelegationApprovalInput,
): Promise<DelegationApprovalResolution> {
  try {
    const kind = input.kind && input.kind.length > 0 ? input.kind : 'code'
    const scopeKey = `delegate:${kind}`
    const { leaderAgentId } = input
    const task = input.task ?? ''
    const targetAgentName = input.targetAgentName
    const taskId = input.taskId ?? null

    const approval = createApproval(db, {
      toolName: scopeKey,
      agentId: leaderAgentId,
      args: { task, targetAgentName },
      reason: `Delegation${targetAgentName ? ` to ${targetAgentName}` : ''}`,
      taskId,
      neverRemember: true,
    })
    const resolution = (await waitForApproval(db, approval.id)) as DelegationApprovalResolution
    appendAudit(db, {
      eventType: 'approval',
      agentId: leaderAgentId,
      summary: { scopeKey, resolution, approvalId: approval.id },
    })
    return resolution
  } catch {
    // FAIL-CLOSED: a DB/transport error must NOT auto-run a risky delegation.
    return 'timeout'
  }
}

// POST /api/governance/delegation-approval
// Body: { leaderAgentId, kind?, targetAgentName?, task?, taskId? } → { resolution }
export async function delegationApprovalPOST(req: Request, res: Response): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>
  const leaderAgentId = typeof body['leaderAgentId'] === 'string' ? body['leaderAgentId'] : ''
  if (!leaderAgentId) {
    res.status(400).json({ error: 'leaderAgentId required' })
    return
  }
  const kind = typeof body['kind'] === 'string' && body['kind'] ? body['kind'] : undefined
  const task = typeof body['task'] === 'string' ? body['task'] : ''
  const targetAgentName =
    typeof body['targetAgentName'] === 'string' ? body['targetAgentName'] : undefined
  const taskId = typeof body['taskId'] === 'string' ? body['taskId'] : null
  const db = getDb()
  const resolution = await resolveDelegationApproval(db, {
    leaderAgentId,
    targetAgentName,
    task,
    kind,
    taskId,
  })
  res.json({ resolution })
}
