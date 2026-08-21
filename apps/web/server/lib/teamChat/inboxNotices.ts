// Dependency-light inbox-notice helpers — importable from BOTH the executor
// runner and the lifecycle subscribers without closing the module cycle
// (executorRunner → subscribers → teamOrchestrator → serverDeliver →
// executorRunner). Imports only @clawboo/db.

import { enqueueInbox, getTask, teams, type ClawbooDb } from '@clawboo/db'
import { createLogger } from '@clawboo/logger'
import { eq } from 'drizzle-orm'

const log = createLogger('inbox-notices')

/** Mirrors the engine's `:reflectTo:` sdid segment (boardOrchestration.ts —
 *  the two MUST agree; the engine package is deliberately db-free, so the
 *  decoder cannot be shared). */
const SDID_REFLECT_TO_RE = /:reflectTo:([^:]+)/

/** The delegator a task notice should reach: the sdid's reflectTo, else the
 *  team's leader. Null when neither exists (nothing to notify). */
export function recipientFor(db: ClawbooDb, taskId: string, teamId: string | null): string | null {
  const task = getTask(db, taskId)
  const sdid = (task?.sourceDelegationId as string | null) ?? ''
  const reflectTo = sdid.match(SDID_REFLECT_TO_RE)?.[1]
  if (reflectTo) return reflectTo
  if (!teamId) return null
  const team = db
    .select({ leaderAgentId: teams.leaderAgentId })
    .from(teams)
    .where(eq(teams.id, teamId))
    .get() as { leaderAgentId: string | null } | undefined
  return team?.leaderAgentId ?? null
}

/**
 * Durable notice that a task's verification fix loop is exhausted — written to
 * the delegator's (or leader's) mailbox so a parked task is never silent.
 * Delivery rides the next digest / MCP piggyback.
 */
export function notifyVerificationParked(
  db: ClawbooDb,
  taskId: string,
  teamId: string | null,
  detail: string,
): void {
  try {
    const recipient = recipientFor(db, taskId, teamId)
    if (!recipient) return
    enqueueInbox(db, { agentId: recipient, teamId, kind: 'alert', taskId, body: detail })
  } catch (err) {
    log.error({ err, taskId }, 'verification-parked notice failed')
  }
}
