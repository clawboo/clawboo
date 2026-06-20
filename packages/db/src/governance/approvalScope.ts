// Sticky "always-approve per scope" lookup. Delegation approvals reuse the
// existing `tool_call_approvals` handshake; when a leader has previously resolved an
// `allow_always` for a synthetic scope key (e.g. `delegate:<kind>`), a fresh
// prompt is skipped. This is a read-only helper over the existing approvals table.

import { and, desc, eq } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { toolCallApprovals } from '../schema'

export function priorAllowAlways(
  db: ClawbooDb,
  params: { agentId: string; scopeKey: string },
): boolean {
  const row = db
    .select()
    .from(toolCallApprovals)
    .where(
      and(
        eq(toolCallApprovals.agentId, params.agentId),
        eq(toolCallApprovals.toolName, params.scopeKey),
        eq(toolCallApprovals.status, 'allow_always'),
      ),
    )
    .orderBy(desc(toolCallApprovals.createdAt))
    .get()
  return Boolean(row)
}
