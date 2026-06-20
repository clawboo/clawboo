// Read the orchestration event log. Default order is `seq ASC` — CAUSAL order, so
// a trace/graph replay reproduces state deterministically (a deliberate deviation
// from governance/audit's `desc(createdAt)`, which suits a "most-recent" lineage
// feed). Pass `order: 'desc'` for a recent-first events feed.

import { and, asc, desc, eq, gt, gte, inArray, type SQL } from 'drizzle-orm'

import type { OrchestrationEventKind } from '@clawboo/obs'

import type { ClawbooDb } from '../db'
import { orchestrationEvents, type DbOrchestrationEvent } from '../schema'

export interface ListEventsFilter {
  teamId?: string
  taskId?: string
  /** Filter to events emitted for one agent (the per-agent activity scope). */
  agentId?: string
  traceId?: string
  kinds?: OrchestrationEventKind[]
  /** `ts >=` (wall-clock ms). For a recent-window read. */
  since?: number
  /** `seq >` cursor — the strictly-monotonic SSE-tail cursor (collision-free). */
  afterSeq?: number
  limit?: number
  order?: 'asc' | 'desc'
}

export function listEvents(db: ClawbooDb, filter: ListEventsFilter = {}): DbOrchestrationEvent[] {
  const conds: SQL[] = []
  if (filter.teamId) conds.push(eq(orchestrationEvents.teamId, filter.teamId))
  if (filter.taskId) conds.push(eq(orchestrationEvents.taskId, filter.taskId))
  if (filter.agentId) conds.push(eq(orchestrationEvents.agentId, filter.agentId))
  if (filter.traceId) conds.push(eq(orchestrationEvents.traceId, filter.traceId))
  if (filter.kinds && filter.kinds.length)
    conds.push(inArray(orchestrationEvents.kind, filter.kinds))
  if (filter.since) conds.push(gte(orchestrationEvents.ts, filter.since))
  if (filter.afterSeq != null) conds.push(gt(orchestrationEvents.seq, filter.afterSeq))
  const ordering =
    filter.order === 'desc' ? desc(orchestrationEvents.seq) : asc(orchestrationEvents.seq)
  return db
    .select()
    .from(orchestrationEvents)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(ordering)
    .limit(filter.limit ?? 500)
    .all() as DbOrchestrationEvent[]
}
