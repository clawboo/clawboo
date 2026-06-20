// Append-only forensic audit log: installs, approvals, tool calls, budget events,
// cap hits, verifications, circuit breaks — the lineage trail the UI + observability
// read. Insert-only by discipline (no update/delete writer is exported). Secrets
// are scrubbed (reusing the tools-broker `scrubSecrets`) BEFORE storage, since an
// audit row that logged a raw key would itself be an exfiltration surface.
// Indexed by `(agent_id, created_at)` for the "what did this agent do, when" query.

import { randomUUID } from 'node:crypto'

import { and, desc, eq, gte, type SQL } from 'drizzle-orm'

import { withWriteRetry } from '../board/contention'
import type { ClawbooDb } from '../db'
import { governanceAudit, type DbGovernanceAudit } from '../schema'
import { scrubSecrets } from '../tools/scrub'

export type GovernanceEventType =
  | 'install'
  | 'approval'
  | 'tool_call'
  | 'budget'
  | 'cap_hit'
  | 'verification'
  | 'circuit_break'

export interface AppendAuditInput {
  eventType: GovernanceEventType
  agentId?: string | null
  taskId?: string | null
  teamId?: string | null
  tenantId?: string | null
  /** Arbitrary structured detail — scrubbed + JSON-stringified before storage. */
  summary: unknown
}

export function appendAudit(db: ClawbooDb, input: AppendAuditInput): DbGovernanceAudit {
  let summary: string
  try {
    summary = JSON.stringify(scrubSecrets(input.summary))
  } catch {
    summary = JSON.stringify({ note: 'unserializable summary' })
  }
  const row: DbGovernanceAudit = {
    id: randomUUID(),
    eventType: input.eventType,
    agentId: input.agentId ?? null,
    taskId: input.taskId ?? null,
    teamId: input.teamId ?? null,
    tenantId: input.tenantId ?? null,
    summary,
    createdAt: Date.now(),
  }
  withWriteRetry(() => db.insert(governanceAudit).values(row).run())
  return row
}

export interface ListGovernanceAuditFilter {
  agentId?: string
  eventType?: GovernanceEventType
  since?: number
  limit?: number
}

export function listGovernanceAudit(
  db: ClawbooDb,
  filter: ListGovernanceAuditFilter = {},
): DbGovernanceAudit[] {
  const conds: SQL[] = []
  if (filter.agentId) conds.push(eq(governanceAudit.agentId, filter.agentId))
  if (filter.eventType) conds.push(eq(governanceAudit.eventType, filter.eventType))
  if (filter.since) conds.push(gte(governanceAudit.createdAt, filter.since))
  return db
    .select()
    .from(governanceAudit)
    .where(conds.length ? and(...conds) : undefined)
    .orderBy(desc(governanceAudit.createdAt))
    .limit(filter.limit ?? 200)
    .all() as DbGovernanceAudit[]
}
