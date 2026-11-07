// Dependency-light inbox-notice helpers — importable from BOTH the executor
// runner and the lifecycle subscribers without closing the module cycle
// (executorRunner → subscribers → teamOrchestrator → serverDeliver →
// executorRunner). Imports only @clawboo/db and @clawboo/board-core.

import { isHumanAssignment, oneLine, parseWaitingOn, waitsOnOtherWork } from '@clawboo/board-core'
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

/** The longest reply a notice quotes: the whole of it is on the task. The MCP
 *  piggyback shows all of this, and a digest cuts the row at 400 characters. */
const NOTICE_REPLY_MAX_CHARS = 2_000

/** Who hears about a task that now waits on a person: its delegator or the team's
 *  leader, but no agent for a task a person assigned (its result is theirs, on the
 *  card), and not the agent that is the task's own. */
function agentToTell(
  db: ClawbooDb,
  taskId: string,
  teamId: string | null,
  ownAgentId?: string | null,
): string | null {
  if (isHumanAssignment(getTask(db, taskId)?.sourceDelegationId)) return null
  const recipient = recipientFor(db, taskId, teamId)
  return recipient && recipient !== ownAgentId ? recipient : null
}

/**
 * Durable notice that the task runner's agent blocked its own task: the task waits
 * on a person, and the steps after it stay queued. The team engine reports the same
 * ending as a `[Task Update]`. Delivery rides the next digest / MCP piggyback.
 */
export function notifyBlockedByAgent(
  db: ClawbooDb,
  taskId: string,
  teamId: string | null,
  agentId: string,
  reply: string,
): void {
  try {
    const recipient = agentToTell(db, taskId, teamId, agentId)
    if (!recipient) return
    // Where the rest is comes first, because a digest cuts what follows.
    const why = reply
      ? `Its whole reply is on the task. It said: ${reply.slice(0, NOTICE_REPLY_MAX_CHARS)}`
      : 'It did not say why.'
    const task = getTask(db, taskId)
    const title = oneLine(task?.title ?? taskId)
    // Waiting on other work, the board moves it on: telling a delegator it needs a
    // person would have them redo it while it queues itself again.
    const state = waitsOnOtherWork(parseWaitingOn(task?.waitingOn))
      ? 'is waiting on other work. Do not redo or reassign it: it goes back to the queue once that work is done, and comes to a person if it is cancelled.'
      : 'is blocked: its agent needs a person before it can go on.'
    enqueueInbox(db, {
      agentId: recipient,
      teamId,
      kind: 'task_update',
      taskId,
      // Its reply is the agent's words.
      source: agentId,
      body: `“${title}” ${state} ${why}`,
    })
  } catch (err) {
    log.error({ err, taskId }, 'agent-blocked notice failed')
  }
}

/** Durable notice that a task runner's check died with its server, so no run closes
 *  with the usual notice: the task waits on a person. */
export function notifyCheckInterrupted(db: ClawbooDb, taskId: string, teamId: string | null): void {
  try {
    const recipient = agentToTell(db, taskId, teamId)
    if (!recipient) return
    enqueueInbox(db, {
      agentId: recipient,
      teamId,
      kind: 'alert',
      taskId,
      body: `The check on “${oneLine(getTask(db, taskId)?.title ?? taskId)}” did not finish, so the task waits for a person.`,
    })
  } catch (err) {
    log.error({ err, taskId }, 'check-interrupted notice failed')
  }
}
