// Append an orchestration event to the durable log. Mirrors governance/audit.ts:
// insert-only, secrets scrubbed BEFORE storage, written under the jittered
// write-retry. `seq` is omitted so SQLite assigns it atomically (cross-process
// monotonic + never-reused). Best-effort by discipline — observability must never
// throw on a producer's data drift, so an unknown `kind` is coerced (not dropped)
// and an unserializable `data` falls back to a note.

import { randomUUID } from 'node:crypto'

import { orchestrationEventKindSchema, type OrchestrationEventKind } from '@clawboo/obs'

import { withWriteRetry } from '../board/contention'
import type { ClawbooDb } from '../db'
import { orchestrationEvents, type DbOrchestrationEvent } from '../schema'
import { scrubSecrets } from '../tools/scrub'

export interface AppendEventInput {
  kind: OrchestrationEventKind
  ts?: number
  teamId?: string | null
  taskId?: string | null
  agentId?: string | null
  runtime?: string | null
  traceId?: string | null
  spanId?: string | null
  parentSpanId?: string | null
  correlationId?: string | null
  tenantId?: string | null
  /** Arbitrary structured detail — scrubbed + JSON-stringified before storage. */
  data?: Record<string, unknown>
}

export function appendEvent(db: ClawbooDb, input: AppendEventInput): DbOrchestrationEvent {
  const kindParsed = orchestrationEventKindSchema.safeParse(input.kind)
  const kind = kindParsed.success ? kindParsed.data : 'error'

  let data: string
  try {
    data = JSON.stringify(scrubSecrets(input.data ?? {}))
  } catch {
    data = JSON.stringify({ note: 'unserializable data' })
  }

  const now = Date.now()
  const row = {
    id: randomUUID(),
    ts: input.ts ?? now,
    kind,
    teamId: input.teamId ?? null,
    taskId: input.taskId ?? null,
    agentId: input.agentId ?? null,
    runtime: input.runtime ?? null,
    traceId: input.traceId ?? null,
    spanId: input.spanId ?? null,
    parentSpanId: input.parentSpanId ?? null,
    correlationId: input.correlationId ?? null,
    data,
    tenantId: input.tenantId ?? null,
    createdAt: now,
  }
  // `seq` omitted → SQLite allocates it under the write lock.
  return withWriteRetry(() =>
    db.insert(orchestrationEvents).values(row).returning().get(),
  ) as DbOrchestrationEvent
}
