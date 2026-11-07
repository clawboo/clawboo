// ─── The delegation failure breaker ─────────────────────────────────────────
// How many times in a row one agent failed one task, so the team engine can refuse
// a failure, report, hand-off-again loop in code. In the database, because a loop
// that outlives its engine is the one nothing else stops: engines are rebuilt on a
// restart and unloaded when idle.
//
// A row runs out. Memory used to give a count the life of its engine; on disk it
// would refuse a task for good over failures nobody remembers, so an old count reads
// as none. A success clears it, and so does a person's message to the team (the
// server's chat route): someone has looked, and "try again" must work.

import { and, eq } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import { delegationFailures } from '../schema'
import { immediateWrite, withWriteRetry } from './contention'

/** How long a count holds after its last failure. */
export const DELEGATION_FAILURE_WINDOW_MS = 24 * 60 * 60_000

export interface DelegationFailure {
  failures: number
  /** The delegator has been told it is over the limit. */
  notified: boolean
}

const rowOf = (teamId: string, targetAgentId: string, taskKey: string) =>
  and(
    eq(delegationFailures.teamId, teamId),
    eq(delegationFailures.targetAgentId, targetAgentId),
    eq(delegationFailures.taskKey, taskKey),
  )

export function readDelegationFailure(
  db: ClawbooDb,
  teamId: string,
  targetAgentId: string,
  taskKey: string,
  now = Date.now(),
): DelegationFailure {
  const row = db
    .select()
    .from(delegationFailures)
    .where(rowOf(teamId, targetAgentId, taskKey))
    .get()
  if (!row || row.updatedAt <= now - DELEGATION_FAILURE_WINDOW_MS) {
    return { failures: 0, notified: false }
  }
  return { failures: row.failures, notified: row.notifiedAt !== null }
}

export function noteDelegationFailure(
  db: ClawbooDb,
  teamId: string,
  targetAgentId: string,
  taskKey: string,
  now = Date.now(),
): void {
  immediateWrite(db, (tx) => {
    const row = tx
      .select()
      .from(delegationFailures)
      .where(rowOf(teamId, targetAgentId, taskKey))
      .get()
    const fresh = row && row.updatedAt > now - DELEGATION_FAILURE_WINDOW_MS
    tx.insert(delegationFailures)
      .values({ teamId, targetAgentId, taskKey, failures: 1, notifiedAt: null, updatedAt: now })
      .onConflictDoUpdate({
        target: [
          delegationFailures.teamId,
          delegationFailures.targetAgentId,
          delegationFailures.taskKey,
        ],
        set: fresh
          ? { failures: row.failures + 1, updatedAt: now }
          : { failures: 1, notifiedAt: null, updatedAt: now },
      })
      .run()
  })
}

export function markDelegationFailureNotified(
  db: ClawbooDb,
  teamId: string,
  targetAgentId: string,
  taskKey: string,
  now = Date.now(),
): void {
  withWriteRetry(() =>
    db
      .update(delegationFailures)
      .set({ notifiedAt: now })
      .where(rowOf(teamId, targetAgentId, taskKey))
      .run(),
  )
}

export function clearDelegationFailure(
  db: ClawbooDb,
  teamId: string,
  targetAgentId: string,
  taskKey: string,
): void {
  withWriteRetry(() =>
    db
      .delete(delegationFailures)
      .where(rowOf(teamId, targetAgentId, taskKey))
      .run(),
  )
}

/** Every count of a team: a person has spoken to it, or the team is gone. */
export function clearTeamDelegationFailures(db: ClawbooDb, teamId: string): void {
  withWriteRetry(() =>
    db.delete(delegationFailures).where(eq(delegationFailures.teamId, teamId)).run(),
  )
}
