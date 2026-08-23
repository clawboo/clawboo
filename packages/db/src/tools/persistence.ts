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
import { mintStandingRule } from '../grants/repository'
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
  /** `observe` = the call RAN, and a stricter reading of a gate would have
   *  refused it. The row is the only place that record exists, so filtering the
   *  audit on it is how the false-positive rate gets measured before anyone
   *  argues about tightening the gate. */
  decision: 'allow' | 'deny' | 'require_approval' | 'rewrite' | 'observe'
  args: unknown
  tenantId?: string | null
  /** What the gate would have refused, for an `observe` row. Lands in
   *  `resultSummary`, which is otherwise null on a `before` row. */
  note?: string | null
  /** Grant attribution. Null for a core builtin, which no grant governs. */
  grantId?: string | null
  connectorId?: string | null
  /** The standing rule that short-circuited the decision, when one did. */
  ruleId?: string | null
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
        resultSummary: input.note ?? null,
        isError: 0,
        tenantId: input.tenantId ?? null,
        grantId: input.grantId ?? null,
        connectorId: input.connectorId ?? null,
        ruleId: input.ruleId ?? null,
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
  /** Grant attribution. This is the row `lastUsedByGrant` reads, so omitting it
   *  here is what would make a grant's "last used" permanently null. */
  grantId?: string | null
  connectorId?: string | null
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
        grantId: input.grantId ?? null,
        connectorId: input.connectorId ?? null,
        ruleId: null,
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
  grantId?: string | null
  connectorId?: string | null
  /** True when the tool has no scopable argument shape. PERSISTED rather than
   *  recomputed at resolve time, so the resolve path can never mint a durable
   *  rule the prompt did not offer. */
  neverRemember?: boolean
  /** The GrantApprovalReason behind the prompt, e.g. `lethal-trifecta`. */
  ruleReason?: string | null
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
    grantId: input.grantId ?? null,
    connectorId: input.connectorId ?? null,
    neverRemember: input.neverRemember ? 1 : 0,
    ruleReason: input.ruleReason ?? null,
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
      DbToolCallApproval | undefined) ?? null
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

/**
 * How long a remembered "Always" lasts.
 *
 * A rule MUST expire: the matcher treats a null expiry as immortal, and an
 * immortal allow minted from one click is a permission nobody revisits. Thirty
 * days is long enough that the operator is not re-prompted through a piece of
 * work, and short enough that a connector they stopped using stops being
 * pre-authorized.
 */
const STANDING_RULE_TTL_MS = 30 * 24 * 60 * 60_000

/** Resolve a still-pending approval. The `status='pending'` guard makes a second
 *  resolve a no-op (idempotent). */
export function resolveApproval(
  db: ClawbooDb,
  id: string,
  decision: ApprovalDecision,
): DbToolCallApproval | null {
  const changed = withWriteRetry(
    () =>
      db
        .update(toolCallApprovals)
        .set({ status: decision, resolvedAt: Date.now() })
        .where(and(eq(toolCallApprovals.id, id), eq(toolCallApprovals.status, 'pending')))
        .run().changes,
  )
  const row = getApproval(db, id)

  // "ALWAYS" HAS TO MINT SOMETHING, or it is a relabelled "Allow once". Nothing
  // else writes `approval_rules`, so without this the whole standing-rule path
  // was unreachable: `listStandingRules` always returned empty, `decideGrant`
  // never took its allow short-circuit, and the operator was re-prompted for the
  // same call forever while the button promised otherwise.
  //
  // Guarded three ways. `changed` means THIS call did the resolving, so a second
  // resolve of the same approval cannot re-mint. `grantId` must exist because a
  // rule is bound to a grant and cascade-deleted with it. And `neverRemember` is
  // the class the prompt already declared unrememberable (a lethal trifecta, a
  // tainted run); honouring an "Always" for one of those would make that class a
  // lie, which is why the flag is persisted at prompt time rather than recomputed
  // here.
  if (changed > 0 && row && decision === 'allow_always' && row.grantId && !row.neverRemember) {
    mintStandingRule(db, {
      grantId: row.grantId,
      toolName: row.toolName,
      // ANY arguments. The operator was shown one call and asked whether to stop
      // being asked about this tool, so the rule is the broader of the two tiers
      // `findStandingRule` supports. A shape-scoped rule would re-prompt on the
      // next call with a different argument, which is the behaviour they just
      // asked to end.
      argsShape: null,
      decision: 'allow',
      expiresAt: Date.now() + STANDING_RULE_TTL_MS,
      createdFromApprovalId: row.id,
    })
  }
  return row
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

export function persistDescriptorMetadata(
  db: ClawbooDb,
  descriptor: ToolDescriptor,
  /** The connector this tool came from. Omitted for a builtin. */
  connectorId?: string | null,
): void {
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
        connectorId: connectorId ?? null,
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
          connectorId: connectorId ?? null,
          updatedAt: now,
        },
      })
      .run(),
  )
}

export function getDescriptorMetadata(db: ClawbooDb, name: string): DbToolRegistry | null {
  return (
    (db.select().from(toolRegistry).where(eq(toolRegistry.name, name)).get() as
      DbToolRegistry | undefined) ?? null
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
