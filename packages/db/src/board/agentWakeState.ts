// The rows behind agents waking each other (see ./agentWakes). Apart so that writing a
// wake can reach them without a cycle: a person's wake clears a back-and-forth.

import { and, eq, isNull, or } from 'drizzle-orm'

import type { ClawbooDb } from '../db'
import {
  agentWakeChains,
  agentWakeGates,
  tasks,
  type DbAgentWakeChain,
  type DbAgentWakeGate,
} from '../schema'
import type { BoardTx } from './contention'

/**
 * The job a task belongs to: its top-level ancestor, or itself. For work on a person's
 * request that is its main task, so everything filed under one request is one job. Never
 * follows a loop in the data.
 */
export function jobTaskIdOf(tx: ClawbooDb | BoardTx, taskId: string): string {
  const seen = new Set<string>([taskId])
  let at = taskId
  for (;;) {
    const row = tx.select({ parent: tasks.parentTaskId }).from(tasks).where(eq(tasks.id, at)).get()
    if (!row?.parent || seen.has(row.parent)) return at
    seen.add(row.parent)
    at = row.parent
  }
}

export function gateOfJob(tx: ClawbooDb | BoardTx, jobTaskId: string): DbAgentWakeGate | null {
  return (
    (tx.select().from(agentWakeGates).where(eq(agentWakeGates.jobTaskId, jobTaskId)).get() as
      DbAgentWakeGate | undefined) ?? null
  )
}

/** A card taken down. */
export const NO_CARD = {
  cardKind: null,
  cardTaskId: null,
  cardFromAgentId: null,
  cardToAgentId: null,
  cardAt: null,
} as const

const pairKey = (teamId: string | null | undefined, x: string, y: string) => ({
  teamKey: teamId ?? '',
  agentA: x < y ? x : y,
  agentB: x < y ? y : x,
})

const pairIs = (key: ReturnType<typeof pairKey>) =>
  and(
    eq(agentWakeChains.teamKey, key.teamKey),
    eq(agentWakeChains.agentA, key.agentA),
    eq(agentWakeChains.agentB, key.agentB),
  )

export function chainOfPair(
  tx: ClawbooDb | BoardTx,
  teamId: string | null | undefined,
  x: string,
  y: string,
): DbAgentWakeChain | null {
  return (
    (tx
      .select()
      .from(agentWakeChains)
      .where(pairIs(pairKey(teamId, x, y)))
      .get() as DbAgentWakeChain | undefined) ?? null
  )
}

export function writeChainOfPairTx(
  tx: BoardTx,
  teamId: string | null | undefined,
  x: string,
  y: string,
  chain: Pick<DbAgentWakeChain, 'lastFromAgentId' | 'chainCount' | 'updatedAt'>,
): void {
  tx.insert(agentWakeChains)
    .values({ ...pairKey(teamId, x, y), ...chain })
    .onConflictDoUpdate({
      target: [agentWakeChains.teamKey, agentWakeChains.agentA, agentWakeChains.agentB],
      set: chain,
    })
    .run()
}

export function dropChainOfPairTx(
  tx: BoardTx,
  teamId: string | null | undefined,
  x: string,
  y: string,
): void {
  tx.delete(agentWakeChains)
    .where(pairIs(pairKey(teamId, x, y)))
    .run()
}

/** A person spoke on this job: who woke whom on it starts again from here. */
export function clearJobWakePathTx(tx: BoardTx, taskId: string, now: number): void {
  tx.update(agentWakeGates)
    .set({ wakePath: null, updatedAt: now })
    .where(eq(agentWakeGates.jobTaskId, jobTaskIdOf(tx, taskId)))
    .run()
}

/** The job's wake path, as the cycle check reads it. Unreadable reads as none. */
export function parseWakePath(raw: string | null | undefined): string[] {
  if (!raw) return []
  try {
    const parsed: unknown = JSON.parse(raw)
    return Array.isArray(parsed) ? parsed.filter((a): a is string => typeof a === 'string') : []
  } catch {
    return []
  }
}

/** A person stepped in for this agent, so it and whoever it was answering are no longer
 *  running unattended. The hourly count stays: it is about how much ran. */
export function clearAgentWakeChainsTx(
  tx: BoardTx,
  teamId: string | null | undefined,
  agentId: string,
  now: number,
): void {
  tx.delete(agentWakeChains)
    .where(
      and(
        eq(agentWakeChains.teamKey, teamId ?? ''),
        or(eq(agentWakeChains.agentA, agentId), eq(agentWakeChains.agentB, agentId)),
      ),
    )
    .run()
  tx.update(agentWakeGates)
    .set({ ...NO_CARD, updatedAt: now })
    .where(
      and(
        teamId ? eq(agentWakeGates.teamId, teamId) : isNull(agentWakeGates.teamId),
        eq(agentWakeGates.cardKind, 'back_and_forth'),
        or(eq(agentWakeGates.cardFromAgentId, agentId), eq(agentWakeGates.cardToAgentId, agentId)),
      ),
    )
    .run()
}
