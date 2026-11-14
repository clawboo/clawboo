// A due OpenClaw routine waits for the Gateway instead of failing on it.
//
// A routine that runs on an OpenClaw agent goes through the server's connection
// to the Gateway: an agent routine whose agent is on OpenClaw, and a team routine
// whose message goes to an agent on OpenClaw (the team's lead, or the member it
// @mentions). Right after this engine starts (a restart, or a computer that slept
// and was woken for this very routine) that connection is still coming up, often
// with the Gateway itself starting beside it. A fire claimed in that window used
// to fail on the missing connection: a failure that may pass, so the routine kept
// its schedule, but the fire itself was skipped until the next time came round. A
// routine due while the computer was stopped never ran.
//
// So while a Gateway is configured and not connected, such a fire stays queued
// in the ledger, out of the ticker's claims (like one a pause holds), and fires
// once the connection comes up: the ticker rescans on connect. The wait is
// bounded: GATEWAY_WAIT_MS after the ticker first found the fire due and waiting,
// it is claimed anyway and fails as before, so a Gateway that is gone for good
// still shows up as a failed routine rather than one quietly waiting forever. The
// ticker keeps that start time in memory, so a fire queued long ago (a pause, a
// restart) still gets its full wait now. With no Gateway configured there is
// nothing to wait for, and the fire fails at once.

import { agents, type ClawbooDb, type DbScheduledRun } from '@clawboo/db'
import { parseTaskTemplate, routineTargetOf } from '@clawboo/scheduler'
import { eq } from 'drizzle-orm'

import { teamMessageTarget } from '../teamChat/teamOrchestrator'

/** How long a due OpenClaw routine waits for the Gateway connection. */
export const GATEWAY_WAIT_MS = 5 * 60_000

/** The Gateway connection, as the wait reads it. */
export interface GatewayState {
  /** Settings name a Gateway. */
  configured(): boolean
  /** The server's connection to it is up. */
  connected(): boolean
}

/** The agent a fire runs on: the routine's agent, or the one a team routine's message goes to. */
function fireAgentId(db: ClawbooDb, run: DbScheduledRun): string | null {
  const template = parseTaskTemplate(run.taskTemplate)
  if (template && routineTargetOf(template) === 'team') {
    if (!run.teamId) return null
    const stimulus = template.description?.trim() || template.title
    return teamMessageTarget(db, run.teamId, null, stimulus)
  }
  return run.agentId || null
}

/**
 * True when this fire needs the Gateway and cannot have it yet: it runs on an
 * OpenClaw agent, and a Gateway is configured but not connected. How long it may
 * wait is the ticker's business (see GATEWAY_WAIT_MS).
 */
export function routineNeedsGateway(
  db: ClawbooDb,
  run: DbScheduledRun,
  gateway: GatewayState,
): boolean {
  if (gateway.connected()) return false
  const agentId = fireAgentId(db, run)
  if (!agentId) return false
  const row = db
    .select({ runtime: agents.runtime })
    .from(agents)
    .where(eq(agents.id, agentId))
    .get() as { runtime: string } | undefined
  // Settings are a file read, so they come last.
  return row?.runtime === 'openclaw' && gateway.configured()
}
