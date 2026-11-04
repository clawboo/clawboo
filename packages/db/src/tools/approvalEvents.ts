// ─── Approval lifecycle in the orchestration event log ──────────────────────
// Every row written to `tool_call_approvals` is announced twice: once when it
// opens (`approval_requested`) and once when it settles (`approval_resolved`).
// Whatever follows the event log, the Activity feeds and `GET /api/obs/events`
// among them, learns about approvals only from these, so an approval the log
// never mentions is invisible to all of it.
//
// NEVER THE ARGUMENTS. The log is never pruned and is read far more widely than
// the approval row. `argsSummary` is scrubbed of credential-shaped keys, not of
// content, and `reason` and `toolSummary` can carry the command text of a shell
// prompt. The events name the call; what it would do stays on the row.

import type { ApprovalRequestedData, ApprovalResolvedData } from '@clawboo/obs'
import { eq } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { appendEvent, type AppendEventInput } from '../events/appendEvent'
import { parsePersonJson } from '../person'
import { agents, type DbToolCallApproval } from '../schema'

export type ApprovalEventKind = 'approval_requested' | 'approval_resolved'

/** The team the approval's agent belongs to. The row has no team column, and an
 *  agent id that is not a clawboo row (an unmapped OpenClaw id) has no team. */
function teamOfAgent(db: ClawbooDb, agentId: string | null): string | null {
  if (!agentId) return null
  try {
    return (
      db.select({ teamId: agents.teamId }).from(agents).where(eq(agents.id, agentId)).get()
        ?.teamId ?? null
    )
  } catch {
    return null
  }
}

/**
 * The event for one approval row. Never throws, so a caller can hand it straight
 * to a best-effort emitter. `teamId` is used when the caller knows it, null
 * included; left undefined, it is read from the agent's row.
 */
export function approvalEvent(
  db: ClawbooDb,
  kind: ApprovalEventKind,
  row: DbToolCallApproval,
  opts: { teamId?: string | null } = {},
): AppendEventInput {
  const envelope = {
    kind,
    agentId: row.agentId,
    teamId: opts.teamId !== undefined ? opts.teamId : teamOfAgent(db, row.agentId),
    taskId: row.taskId,
    tenantId: row.tenantId,
  }
  if (kind === 'approval_requested') {
    const data: ApprovalRequestedData = {
      approvalId: row.id,
      kind: row.kind,
      toolName: row.toolName,
      toolClass: row.toolClass,
      grantId: row.grantId,
      connectorId: row.connectorId,
      expiresAt: row.expiresAt,
    }
    return { ...envelope, data: { ...data } }
  }
  // Who answered, only when a sign-in proxy vouched for them: never a guess.
  const resolvedBy = parsePersonJson(row.resolvedBy)
  const data: ApprovalResolvedData = {
    approvalId: row.id,
    decision: row.status,
    kind: row.kind,
    toolName: row.toolName,
    ...(resolvedBy ? { resolvedBy } : {}),
  }
  return { ...envelope, data: { ...data } }
}

/** Append the event for one approval row. Best-effort: observability must never
 *  fail the write it describes. */
export function recordApprovalEvent(
  db: ClawbooDb,
  kind: ApprovalEventKind,
  row: DbToolCallApproval,
  opts: { teamId?: string | null } = {},
): void {
  try {
    appendEvent(db, approvalEvent(db, kind, row, opts))
  } catch {
    /* best-effort */
  }
}
