// ─── Tools persistence — audit + approval handshake + registry metadata ─────
// The DB-mediated layer shared by both transports (in-process Express + the
// stdio bin): every call is audited (args/results scrubbed); a risky call opens
// an approval row the UI resolves; the broker polls it. Registry metadata is
// persisted so the UI + audit can read tool info + the enabled/provenance state.

import { randomUUID } from 'node:crypto'

import { and, desc, eq, gt, lt } from 'drizzle-orm'

import { withWriteRetry } from '../board/contention'
import type { ClawbooDb } from '../db'
import {
  toolCallApprovals,
  toolCallAudit,
  toolRegistry,
  type DbToolCallApproval,
  type DbToolCallAudit,
  type DbToolRegistry,
} from '../schema'
import { createBuiltinRegistry } from './registry'
import { scrubArgsSummary, scrubResultSummary } from './scrub'
import type { ToolDescriptor } from './types'

const DEFAULT_TTL_MS = 5 * 60_000
const DEFAULT_TIMEOUT_MS = 2 * 60_000
const DEFAULT_POLL_MS = 250

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

// ─── Audit ───────────────────────────────────────────────────────────────────

export interface AuditBeforeInput {
  toolName: string
  agentId?: string | null
  decision: 'allow' | 'deny' | 'require_approval' | 'rewrite'
  args: unknown
  tenantId?: string | null
}

export function writeAuditBefore(db: ClawbooDb, input: AuditBeforeInput): string {
  const id = randomUUID()
  withWriteRetry(() =>
    db
      .insert(toolCallAudit)
      .values({
        id,
        toolName: input.toolName,
        agentId: input.agentId ?? null,
        phase: 'before',
        decision: input.decision,
        argsSummary: scrubArgsSummary(input.args),
        resultSummary: null,
        isError: 0,
        tenantId: input.tenantId ?? null,
        createdAt: Date.now(),
      })
      .run(),
  )
  return id
}

export interface AuditAfterInput {
  toolName: string
  agentId?: string | null
  result: string
  isError: boolean
  tenantId?: string | null
}

export function writeAuditAfter(db: ClawbooDb, input: AuditAfterInput): string {
  const id = randomUUID()
  withWriteRetry(() =>
    db
      .insert(toolCallAudit)
      .values({
        id,
        toolName: input.toolName,
        agentId: input.agentId ?? null,
        phase: 'after',
        decision: null,
        argsSummary: null,
        resultSummary: scrubResultSummary(input.result),
        isError: input.isError ? 1 : 0,
        tenantId: input.tenantId ?? null,
        createdAt: Date.now(),
      })
      .run(),
  )
  return id
}

export function listAudit(
  db: ClawbooDb,
  filter: { toolName?: string; limit?: number } = {},
): DbToolCallAudit[] {
  const conds = filter.toolName ? eq(toolCallAudit.toolName, filter.toolName) : undefined
  return db
    .select()
    .from(toolCallAudit)
    .where(conds)
    .orderBy(desc(toolCallAudit.createdAt))
    .limit(filter.limit ?? 100)
    .all() as DbToolCallAudit[]
}

// ─── Approval handshake ───────────────────────────────────────────────────────

export type ApprovalDecision = 'allow_once' | 'allow_always' | 'deny'
export type ApprovalResolution = ApprovalDecision | 'expired' | 'timeout'

export interface CreateApprovalInput {
  toolName: string
  agentId?: string | null
  args: unknown
  reason?: string | null
  ttlMs?: number
  tenantId?: string | null
  /** The board task this approval gates (so the TTL reaper can unblock it). */
  taskId?: string | null
}

export function createApproval(db: ClawbooDb, input: CreateApprovalInput): DbToolCallApproval {
  const now = Date.now()
  const row: DbToolCallApproval = {
    id: randomUUID(),
    toolName: input.toolName,
    agentId: input.agentId ?? null,
    argsSummary: scrubArgsSummary(input.args),
    reason: input.reason ?? null,
    status: 'pending',
    taskId: input.taskId ?? null,
    tenantId: input.tenantId ?? null,
    createdAt: now,
    expiresAt: now + (input.ttlMs ?? DEFAULT_TTL_MS),
    resolvedAt: null,
  }
  withWriteRetry(() => db.insert(toolCallApprovals).values(row).run())
  return row
}

export function getApproval(db: ClawbooDb, id: string): DbToolCallApproval | null {
  return (
    (db.select().from(toolCallApprovals).where(eq(toolCallApprovals.id, id)).get() as
      | DbToolCallApproval
      | undefined) ?? null
  )
}

export function listPendingApprovals(db: ClawbooDb): DbToolCallApproval[] {
  return db
    .select()
    .from(toolCallApprovals)
    .where(
      and(eq(toolCallApprovals.status, 'pending'), gt(toolCallApprovals.expiresAt, Date.now())),
    )
    .orderBy(desc(toolCallApprovals.createdAt))
    .all() as DbToolCallApproval[]
}

/** Resolve a still-pending approval. The `status='pending'` guard makes a second
 *  resolve a no-op (idempotent). */
export function resolveApproval(
  db: ClawbooDb,
  id: string,
  decision: ApprovalDecision,
): DbToolCallApproval | null {
  withWriteRetry(() =>
    db
      .update(toolCallApprovals)
      .set({ status: decision, resolvedAt: Date.now() })
      .where(and(eq(toolCallApprovals.id, id), eq(toolCallApprovals.status, 'pending')))
      .run(),
  )
  return getApproval(db, id)
}

/**
 * Poll a pending approval until it's resolved, expires, or the wait times out.
 * Uniform across both transports (in-process Express + stdio bin) — the UI
 * resolves the row via REST and the broker (in whichever process) sees it.
 */
export async function waitForApproval(
  db: ClawbooDb,
  id: string,
  opts: { timeoutMs?: number; pollMs?: number } = {},
): Promise<ApprovalResolution> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const pollMs = opts.pollMs ?? DEFAULT_POLL_MS
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const row = getApproval(db, id)
    if (!row) return 'timeout'
    if (row.status !== 'pending') return row.status as ApprovalDecision
    if (Date.now() > row.expiresAt) return 'expired'
    if (Date.now() > deadline) return 'timeout'
    await sleep(pollMs)
  }
}

/**
 * Durable TTL reaper: atomically expire ABANDONED pending approvals — those
 * created more than `olderThanMs` ago that no one ever resolved (distinct from the
 * per-call `expiresAt` waiter deadline). Sets `status='expired'` + `resolvedAt` and
 * returns ONLY the rows expired by THIS call (the `status='pending'` guard +
 * RETURNING make a second pass a no-op). The caller audits + unblocks each task.
 */
export function expireStaleApprovals(
  db: ClawbooDb,
  opts: { olderThanMs: number },
): DbToolCallApproval[] {
  const now = Date.now()
  const cutoff = now - Math.max(0, opts.olderThanMs)
  return withWriteRetry(
    () =>
      db
        .update(toolCallApprovals)
        .set({ status: 'expired', resolvedAt: now })
        .where(
          and(eq(toolCallApprovals.status, 'pending'), lt(toolCallApprovals.createdAt, cutoff)),
        )
        .returning()
        .all() as DbToolCallApproval[],
  )
}

// ─── Registry metadata (light) ────────────────────────────────────────────────

export function persistDescriptorMetadata(db: ClawbooDb, descriptor: ToolDescriptor): void {
  const now = Date.now()
  withWriteRetry(() =>
    db
      .insert(toolRegistry)
      .values({
        name: descriptor.name,
        description: descriptor.description,
        inputSchema: null,
        availability: descriptor.availability ? JSON.stringify(descriptor.availability) : null,
        owner: descriptor.owner ?? 'core',
        provenanceSignerId: descriptor.provenance?.signerId ?? null,
        provenanceSignature: descriptor.provenance?.signature ?? null,
        provenanceSignedAt: descriptor.provenance?.signedAt ?? null,
        enabled: 1,
        createdAt: now,
        updatedAt: now,
      })
      .onConflictDoUpdate({
        target: toolRegistry.name,
        set: {
          description: descriptor.description,
          availability: descriptor.availability ? JSON.stringify(descriptor.availability) : null,
          owner: descriptor.owner ?? 'core',
          provenanceSignerId: descriptor.provenance?.signerId ?? null,
          provenanceSignature: descriptor.provenance?.signature ?? null,
          provenanceSignedAt: descriptor.provenance?.signedAt ?? null,
          updatedAt: now,
        },
      })
      .run(),
  )
}

export function getDescriptorMetadata(db: ClawbooDb, name: string): DbToolRegistry | null {
  return (
    (db.select().from(toolRegistry).where(eq(toolRegistry.name, name)).get() as
      | DbToolRegistry
      | undefined) ?? null
  )
}

/** A tool is enabled unless a registry row explicitly disables it. */
export function isToolEnabled(db: ClawbooDb, name: string): boolean {
  const row = getDescriptorMetadata(db, name)
  return row ? row.enabled === 1 : true
}

export function setToolEnabled(db: ClawbooDb, name: string, enabled: boolean): void {
  withWriteRetry(() =>
    db
      .update(toolRegistry)
      .set({ enabled: enabled ? 1 : 0, updatedAt: Date.now() })
      .where(eq(toolRegistry.name, name))
      .run(),
  )
}

/**
 * Seed the registry with the builtin tool descriptors so every brokered tool has a
 * row carrying its description / availability / owner / provenance + the enabled
 * flag. Without this the table is empty: `setToolEnabled` UPDATEs zero rows (a
 * silent no-op) and `isToolEnabled` falls back to `true`, so disabling a brokered
 * tool changes nothing. Idempotent — `persistDescriptorMetadata` upserts and its
 * conflict-set does NOT touch `enabled`, so a re-seed preserves a user's disable.
 */
export function seedBuiltinTools(db: ClawbooDb): void {
  for (const descriptor of createBuiltinRegistry().list()) {
    persistDescriptorMetadata(db, descriptor)
  }
}
