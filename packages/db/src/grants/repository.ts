// The ONLY reader and writer of `capability_grants` and `approval_rules`.
//
// One rule governs this file: the graph and the broker must reach `decideGrant`
// through the SAME candidate query, keyed the same way. A second reader with a
// slightly different join is how a badge starts asserting a verdict the runtime
// would never reach, which is the exact failure the grant spine exists to make
// structurally impossible. `listCandidateGrants` is that one query.
//
// Two things are deliberately ABSENT as columns and derived instead:
// `lastUsedAt` and the rate window. A team- or global-scoped grant is a hot
// single row on a single-writer database, and a per-call write to it can block
// the event loop for the whole retry budget. Both come from `tool_call_audit`
// via `idx_tool_audit_grant`.

import { randomUUID } from 'node:crypto'
import { and, desc, eq, inArray, isNull, lte, or, sql } from 'drizzle-orm'
import type { Grant, GrantState, StandingRule } from '@clawboo/governance'

import { immediateWrite, withWriteRetry } from '../board/contention'
import type { ClawbooDb } from '../db'
import {
  approvalRules,
  capabilityGrants,
  toolCallApprovals,
  toolCallAudit,
  type DbApprovalRule,
  type DbCapabilityGrant,
} from '../schema'
import { grantKey, normalizeGrantIdentity, ruleKey, type GrantIdentity } from './key'
import { rowToGrant, rowToStandingRule } from './rows'

/**
 * How a grant came to exist.
 * - `owner`    the runtime's own config already attaches this capability to this
 *              subject, so the row records what is already true. Never drawn as
 *              an edge: the tile IS that statement. It exists so the gate has no
 *              hole for a connector's own agent.
 * - `operator` a human deliberately shared it. This is what draws an edge.
 */
export type GrantOrigin = 'owner' | 'operator'

export interface GrantRow extends Grant {
  origin: GrantOrigin
  grantedBy: string | null
  grantedAt: number
  revokedAt: number | null
  revokedReason: string | null
}

function rowToGrantRow(row: DbCapabilityGrant): GrantRow {
  return {
    ...rowToGrant(row),
    origin: row.origin === 'owner' ? 'owner' : 'operator',
    grantedBy: row.grantedBy,
    grantedAt: row.grantedAt,
    revokedAt: row.revokedAt,
    revokedReason: row.revokedReason,
  }
}

// ─── Reads ───────────────────────────────────────────────────────────────────

export function getGrant(db: ClawbooDb, id: string): GrantRow | null {
  const row = db.select().from(capabilityGrants).where(eq(capabilityGrants.id, id)).get() as
    DbCapabilityGrant | undefined
  return row ? rowToGrantRow(row) : null
}

export interface CandidateFilter {
  /** The calling agent. Its own grants are the most specific candidates. */
  agentId?: string | null
  /** The agent's team, when known. A team grant covers every member. */
  teamId?: string | null
  /** Agent-independent capability identity. Preferred when present. */
  connectorId?: string | null
  /** Agent-scoped fallback identity, used only when there is no connectorId. */
  capabilityId?: string | null
}

/**
 * Every grant that could authorize a call, for BOTH consumers.
 *
 * Subject breadth is a union, not a precedence: `decideGrant` picks the most
 * specific itself (`selectGrant`), and handing it a pre-narrowed set would move
 * that choice into a second place where it could diverge.
 *
 * Returns `[]` when the filter names no capability at all, rather than every
 * grant in the table. A caller with no identity in hand is asking a question
 * that has no safe answer, and `decideGrant` reads an empty list as
 * `deny: no-grant`, which is the right one.
 */
export function listCandidateGrants(db: ClawbooDb, filter: CandidateFilter): GrantRow[] {
  const capability =
    filter.connectorId != null
      ? eq(capabilityGrants.connectorId, filter.connectorId)
      : filter.capabilityId != null
        ? eq(capabilityGrants.capabilityId, filter.capabilityId)
        : null
  if (capability === null) return []

  const subjects = [
    // A global grant has subject_id NULL, so it needs an IS NULL rather than an
    // equality: SQLite never matches NULL with `=`, and a global owner grant is
    // the one an HTTP-attached runtime falls back to.
    and(eq(capabilityGrants.subjectKind, 'global'), isNull(capabilityGrants.subjectId)),
    ...(filter.agentId
      ? [
          and(
            eq(capabilityGrants.subjectKind, 'agent'),
            eq(capabilityGrants.subjectId, filter.agentId),
          ),
        ]
      : []),
    ...(filter.teamId
      ? [
          and(
            eq(capabilityGrants.subjectKind, 'team'),
            eq(capabilityGrants.subjectId, filter.teamId),
          ),
        ]
      : []),
  ]

  return (
    db
      .select()
      .from(capabilityGrants)
      .where(and(capability, or(...subjects)))
      .all() as DbCapabilityGrant[]
  ).map(rowToGrantRow)
}

/** Every grant, newest first. Backs `GET /api/grants`. */
export function listGrants(db: ClawbooDb, filter: { subjectId?: string } = {}): GrantRow[] {
  const rows = (
    filter.subjectId
      ? db
          .select()
          .from(capabilityGrants)
          .where(eq(capabilityGrants.subjectId, filter.subjectId))
          .orderBy(desc(capabilityGrants.grantedAt))
          .all()
      : db.select().from(capabilityGrants).orderBy(desc(capabilityGrants.grantedAt)).all()
  ) as DbCapabilityGrant[]
  return rows.map(rowToGrantRow)
}

/** Standing rules for one grant. Expiry is left to `decideGrant`, which already
 *  ignores a past one, so a rule the sweep has not reaped yet is still inert. */
export function listStandingRules(db: ClawbooDb, grantId: string): StandingRule[] {
  return (
    db
      .select()
      .from(approvalRules)
      .where(eq(approvalRules.grantId, grantId))
      .all() as DbApprovalRule[]
  ).map(rowToStandingRule)
}

/**
 * When each grant was last actually used, DERIVED from the audit table.
 *
 * This is why `capability_grants` carries no `last_used_at`: the column would be
 * a per-call write to a possibly-shared row. One indexed grouped read gives the
 * same answer with no write at all.
 */
export function lastUsedByGrant(db: ClawbooDb, grantIds: readonly string[]): Map<string, number> {
  if (grantIds.length === 0) return new Map()
  const rows = db
    .select({
      grantId: toolCallAudit.grantId,
      lastUsed: sql<number>`MAX(${toolCallAudit.createdAt})`,
    })
    .from(toolCallAudit)
    .where(and(inArray(toolCallAudit.grantId, [...grantIds]), eq(toolCallAudit.phase, 'after')))
    .groupBy(toolCallAudit.grantId)
    .all() as Array<{ grantId: string | null; lastUsed: number | null }>
  const out = new Map<string, number>()
  for (const r of rows) if (r.grantId && r.lastUsed) out.set(r.grantId, r.lastUsed)
  return out
}

/** Pending approvals per grant: the count the graph renders as a marching edge. */
export function pendingApprovalsByGrant(
  db: ClawbooDb,
  grantIds: readonly string[],
): Map<string, number> {
  if (grantIds.length === 0) return new Map()
  const rows = db
    .select({
      grantId: toolCallApprovals.grantId,
      n: sql<number>`COUNT(*)`,
    })
    .from(toolCallApprovals)
    .where(
      and(
        inArray(toolCallApprovals.grantId, [...grantIds]),
        eq(toolCallApprovals.status, 'pending'),
      ),
    )
    .groupBy(toolCallApprovals.grantId)
    .all() as Array<{ grantId: string | null; n: number }>
  const out = new Map<string, number>()
  for (const r of rows) if (r.grantId) out.set(r.grantId, r.n)
  return out
}

// ─── Writes ──────────────────────────────────────────────────────────────────

export interface UpsertGrantInput extends GrantIdentity {
  toolAllow?: string[]
  toolDeny?: string[]
  mode?: Grant['mode']
  approvalPolicy?: Grant['approvalPolicy']
  origin?: GrantOrigin
  expiresAt?: number | null
  specHashPin?: string | null
  toolsHashPin?: string | null
  callCeilingPerHour?: number | null
  grantedBy?: string | null
}

/**
 * Insert a grant, or WIDEN/NARROW an existing one for the same identity.
 *
 * The update set is PRESENCE-GATED on purpose. The shipped client sends neither
 * `expiresAt` nor `callCeilingPerHour`, so a blanket update would silently clear
 * a time-box and a call ceiling an operator had set, every time anyone re-shared
 * the same connector. An absent field means "leave it alone", never "reset it".
 */
export function upsertGrant(db: ClawbooDb, input: UpsertGrantInput): GrantRow {
  const identity = normalizeGrantIdentity(input)
  const key = grantKey(identity)
  const now = Date.now()

  return immediateWrite(db, (tx) => {
    const existing = tx
      .select()
      .from(capabilityGrants)
      .where(eq(capabilityGrants.grantKey, key))
      .get() as DbCapabilityGrant | undefined

    if (!existing) {
      const row = {
        id: randomUUID(),
        grantKey: key,
        subjectKind: identity.subjectKind,
        subjectId: identity.subjectId,
        capabilityKind: identity.capabilityKind,
        connectorId: identity.connectorId,
        capabilityId: identity.capabilityId,
        toolAllow: JSON.stringify(input.toolAllow ?? ['*']),
        toolDeny: JSON.stringify(input.toolDeny ?? []),
        mode: input.mode ?? 'read',
        approvalPolicy: input.approvalPolicy ?? 'risk',
        state: 'active',
        origin: input.origin ?? 'operator',
        expiresAt: input.expiresAt ?? null,
        specHashPin: input.specHashPin ?? null,
        toolsHashPin: input.toolsHashPin ?? null,
        callCeilingPerHour: input.callCeilingPerHour ?? null,
        grantedBy: input.grantedBy ?? null,
        grantedAt: now,
        revokedAt: null,
        revokedReason: null,
        tenantId: null,
        createdAt: now,
        updatedAt: now,
      } satisfies DbCapabilityGrant
      tx.insert(capabilityGrants).values(row).run()
      return rowToGrantRow(row)
    }

    const update: Partial<DbCapabilityGrant> = {
      // Re-granting a revoked or expired grant is the point of re-granting it.
      state: 'active',
      revokedAt: null,
      revokedReason: null,
      updatedAt: now,
      grantedAt: now,
    }
    if (input.toolAllow !== undefined) update.toolAllow = JSON.stringify(input.toolAllow)
    if (input.toolDeny !== undefined) update.toolDeny = JSON.stringify(input.toolDeny)
    if (input.mode !== undefined) update.mode = input.mode
    if (input.approvalPolicy !== undefined) update.approvalPolicy = input.approvalPolicy
    if (input.expiresAt !== undefined) update.expiresAt = input.expiresAt
    if (input.specHashPin !== undefined) update.specHashPin = input.specHashPin
    if (input.toolsHashPin !== undefined) update.toolsHashPin = input.toolsHashPin
    if (input.callCeilingPerHour !== undefined) update.callCeilingPerHour = input.callCeilingPerHour
    if (input.grantedBy !== undefined) update.grantedBy = input.grantedBy
    // ONE-WAY promotion. An owner grant that a human then deliberately shares
    // becomes operator-origin, because only an operator grant is drawn as an
    // edge and carries a Detach control: without this, sharing a connector the
    // grantee's own runtime already attaches would reactivate the owner row,
    // report success, and leave the operator unable to see or revoke what they
    // just created. The reverse never happens: a deliberate share does not decay
    // back into an implicit one.

    if (input.origin === 'operator' && existing.origin !== 'operator') update.origin = 'operator'

    tx.update(capabilityGrants).set(update).where(eq(capabilityGrants.id, existing.id)).run()
    return rowToGrantRow({ ...existing, ...update } as DbCapabilityGrant)
  })
}

/**
 * Mint an OWNER grant if and only if no grant exists for this identity.
 *
 * Insert-only, and that is the whole contract: the capability projection runs on
 * every inventory read, so an update here would resurrect a grant a human had
 * just revoked, on the very next refresh. Revoking an owner grant has to stick.
 */
export function ensureOwnerGrant(db: ClawbooDb, input: UpsertGrantInput): GrantRow | null {
  const identity = normalizeGrantIdentity(input)
  const key = grantKey(identity)
  const now = Date.now()

  return immediateWrite(db, (tx) => {
    const existing = tx
      .select()
      .from(capabilityGrants)
      .where(eq(capabilityGrants.grantKey, key))
      .get() as DbCapabilityGrant | undefined
    if (existing) return null

    const row = {
      id: randomUUID(),
      grantKey: key,
      subjectKind: identity.subjectKind,
      subjectId: identity.subjectId,
      capabilityKind: identity.capabilityKind,
      connectorId: identity.connectorId,
      capabilityId: identity.capabilityId,
      toolAllow: JSON.stringify(input.toolAllow ?? ['*']),
      toolDeny: JSON.stringify(input.toolDeny ?? []),
      // admin, because the runtime's own config already gives this subject
      // unrestricted use. A narrower owner grant would DENY calls that work
      // today, which would be a regression dressed up as governance.
      mode: input.mode ?? 'admin',
      approvalPolicy: input.approvalPolicy ?? 'risk',
      state: 'active',
      origin: 'owner',
      expiresAt: null,
      specHashPin: input.specHashPin ?? null,
      toolsHashPin: input.toolsHashPin ?? null,
      callCeilingPerHour: null,
      grantedBy: null,
      grantedAt: now,
      revokedAt: null,
      revokedReason: null,
      tenantId: null,
      createdAt: now,
      updatedAt: now,
    } satisfies DbCapabilityGrant
    tx.insert(capabilityGrants).values(row).run()
    return rowToGrantRow(row)
  })
}

/**
 * Re-pin an ACTIVE owner grant's hashes, on an explicit operator action.
 *
 * The counterpart to `ensureOwnerGrant` being insert-only. The pins record what
 * the operator consented to; when they reconnect with a different launch
 * argument, or the catalog ships a new pinned version, the live hashes stop
 * matching and the gate denies `spec-drift` on every call. There is no way back
 * from that on the automatic path, because ensure returns null for an existing
 * grant and nothing else writes the pins.
 *
 * OWNER ORIGIN AND ACTIVE STATE ONLY, which is what keeps this from being a
 * drift bypass. An operator grant is a deliberate human share: its pins are the
 * snapshot a person approved, and a reconnect must not silently re-approve a
 * changed server on their behalf. A suspended grant is off for a reason this
 * reconnect has not addressed. Both are left exactly as they are.
 *
 * Each pin is written only when the caller PASSES it, which is what lets a
 * reconnect re-pin the spec the operator just looked at while leaving the tool
 * inventory pinned to the snapshot nobody has reviewed.
 */
export function repinOwnerGrant(db: ClawbooDb, input: UpsertGrantInput): GrantRow | null {
  const identity = normalizeGrantIdentity(input)
  const key = grantKey(identity)
  const now = Date.now()

  return immediateWrite(db, (tx) => {
    const existing = tx
      .select()
      .from(capabilityGrants)
      .where(eq(capabilityGrants.grantKey, key))
      .get() as DbCapabilityGrant | undefined
    if (!existing) return null
    if (existing.origin !== 'owner' || existing.state !== 'active') return rowToGrantRow(existing)

    const update: Partial<DbCapabilityGrant> = {
      updatedAt: now,
      ...(input.specHashPin !== undefined ? { specHashPin: input.specHashPin } : {}),
      ...(input.toolsHashPin !== undefined ? { toolsHashPin: input.toolsHashPin } : {}),
    }
    tx.update(capabilityGrants).set(update).where(eq(capabilityGrants.id, existing.id)).run()
    return rowToGrantRow({ ...existing, ...update } as DbCapabilityGrant)
  })
}

/**
 * Reinstate a revoked or expired OWNER grant, on an explicit operator action.
 *
 * Deliberately separate from `ensureOwnerGrant`, and the split is the whole
 * point. `ensureOwnerGrant` runs on every inventory read and must never
 * resurrect what a human revoked. But insert-only with no counterpart means a
 * revoked owner grant is PERMANENT: the key carries no state component, so the
 * next ensure returns null, `selectGrant` keeps choosing the revoked row, and
 * every call denies `grant-revoked` with no way back short of editing the
 * database. `resumeGrant` does not cover it either -- that window is 15 seconds
 * and exists for an accidental Detach, not for a deliberate reconnect.
 *
 * So: the automatic path never reinstates, and this explicit one does.
 */
export function reinstateOwnerGrant(db: ClawbooDb, input: UpsertGrantInput): GrantRow | null {
  const identity = normalizeGrantIdentity(input)
  const key = grantKey(identity)
  const now = Date.now()

  return immediateWrite(db, (tx) => {
    const existing = tx
      .select()
      .from(capabilityGrants)
      .where(eq(capabilityGrants.grantKey, key))
      .get() as DbCapabilityGrant | undefined
    if (!existing) return null
    // OWNER ORIGIN ONLY, and the check is the whole safety of this function. An
    // operator grant is a deliberate human share; revoking one is a deliberate
    // human decision. Reinstating it because someone reconnected the underlying
    // connector would silently undo that decision, which is precisely the
    // bypass this path must not become.
    if (existing.origin !== 'owner') return rowToGrantRow(existing)
    // An ACTIVE grant is already what the caller wants; a suspended one is off
    // for a reason the caller has not addressed (drift, a failed re-auth, the
    // freeze), and quietly clearing that would be the resurrection this split
    // exists to prevent.
    if (existing.state !== 'revoked' && existing.state !== 'expired') return rowToGrantRow(existing)

    const update: Partial<DbCapabilityGrant> = {
      state: 'active',
      revokedAt: null,
      revokedReason: null,
      grantedAt: now,
      updatedAt: now,
      // A reconnect re-pins: the hashes are what the operator is consenting to
      // NOW, and carrying the old pin forward would report drift against a
      // snapshot nobody has seen since.
      ...(input.specHashPin !== undefined ? { specHashPin: input.specHashPin } : {}),
      ...(input.toolsHashPin !== undefined ? { toolsHashPin: input.toolsHashPin } : {}),
    }
    tx.update(capabilityGrants).set(update).where(eq(capabilityGrants.id, existing.id)).run()
    return rowToGrantRow({ ...existing, ...update } as DbCapabilityGrant)
  })
}

/**
 * Revoke a grant and CASCADE-DELETE its standing rules.
 *
 * The cascade is the point: a remembered "Always" outliving the grant it was
 * recorded against would let a re-grant silently inherit approvals the operator
 * gave under different circumstances. Deleting them is also what makes revoke
 * terminal to the gate even inside the brief resume window below.
 */
export function revokeGrant(db: ClawbooDb, id: string, reason: string | null): GrantRow | null {
  const now = Date.now()
  immediateWrite(db, (tx) => {
    tx.update(capabilityGrants)
      .set({ state: 'revoked', revokedAt: now, revokedReason: reason, updatedAt: now })
      .where(and(eq(capabilityGrants.id, id), eq(capabilityGrants.state, 'active')))
      .run()
    tx.delete(approvalRules).where(eq(approvalRules.grantId, id)).run()
  })
  return getGrant(db, id)
}

/** How long after a revoke the shipped 8-second Undo toast can still resume it. */
export const RESUME_WINDOW_MS = 15_000

/**
 * Undo a revoke, but only inside a bounded window.
 *
 * `revoked` is documented terminal, and the shipped Detach toast offers an
 * 8-second Undo. This window is the negotiated resolution: revoked is terminal
 * to the GATE instantly (and permanently for the deleted standing rules) while
 * the ROW stays briefly restorable. `expired` is deliberately NOT restorable
 * here, because an expiry is not a decision anyone is undoing.
 */
export function resumeGrant(db: ClawbooDb, id: string, now = Date.now()): GrantRow | null {
  const current = getGrant(db, id)
  if (!current) return null
  if (current.state !== 'revoked') return current.state === 'active' ? current : null
  if (current.revokedAt === null || now - current.revokedAt > RESUME_WINDOW_MS) return null

  withWriteRetry(() =>
    db
      .update(capabilityGrants)
      .set({ state: 'active', revokedAt: null, revokedReason: null, updatedAt: now })
      .where(and(eq(capabilityGrants.id, id), eq(capabilityGrants.state, 'revoked')))
      .run(),
  )
  return getGrant(db, id)
}

/**
 * Move past-expiry ACTIVE grants to `expired`, and drop past-expiry rules.
 *
 * Cosmetic for the gate, which already denies `grant-expired` from the timestamp
 * alone, and load-bearing for everything that reads `state` without running a
 * decision: a list, a count, an audit query.
 */
export function sweepExpiredGrants(
  db: ClawbooDb,
  now = Date.now(),
): { grants: number; rules: number } {
  return immediateWrite(db, (tx) => {
    const grants = tx
      .update(capabilityGrants)
      .set({ state: 'expired' satisfies GrantState, updatedAt: now })
      .where(and(eq(capabilityGrants.state, 'active'), lte(capabilityGrants.expiresAt, now)))
      .run().changes
    const rules = tx.delete(approvalRules).where(lte(approvalRules.expiresAt, now)).run().changes
    return { grants, rules }
  })
}

export interface MintStandingRuleInput {
  grantId: string
  toolName: string
  argsShape: string | null
  decision: 'allow' | 'deny'
  /** Epoch ms. Required: the matcher treats a null expiry as immortal. */
  expiresAt: number
  createdFromApprovalId?: string | null
}

export function mintStandingRule(db: ClawbooDb, input: MintStandingRuleInput): DbApprovalRule {
  const now = Date.now()
  const row = {
    id: randomUUID(),
    ruleKey: ruleKey(input.grantId, input.toolName, input.argsShape),
    grantId: input.grantId,
    toolName: input.toolName,
    argsShape: input.argsShape,
    decision: input.decision,
    createdFromApprovalId: input.createdFromApprovalId ?? null,
    expiresAt: input.expiresAt,
    tenantId: null,
    createdAt: now,
  } satisfies DbApprovalRule

  // `.returning().get()` rather than the local `row`: on conflict the UNIQUE
  // index preserves the EXISTING id, so returning the id we just generated would
  // hand the caller a key no row has, and any audit attribution written from it
  // would dangle.
  return withWriteRetry(
    () =>
      db
        .insert(approvalRules)
        .values(row)
        .onConflictDoUpdate({
          target: approvalRules.ruleKey,
          set: {
            decision: row.decision,
            expiresAt: row.expiresAt,
            createdFromApprovalId: row.createdFromApprovalId,
            createdAt: now,
          },
        })
        .returning()
        .get() as DbApprovalRule,
  )
}
