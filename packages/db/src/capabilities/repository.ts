// ─── Capability inventory repository (data-access layer) ─────────────────────
// The ONLY place that reads/writes the `capabilities` table — the durable
// projection of the unified capability inventory. Mirrors the board repository
// convention (keeps raw Drizzle out of apps/web; the single seam a future
// SQLite→Postgres / multi-tenant swap targets). `upsertCapabilities` is a
// SOURCE-SCOPED reconcile: a re-read from one adapter replaces only that
// adapter's rows, never another's — so a disconnected Gateway never wipes the
// native/Hermes rows. The row is a cache; a fresh `read()` repopulates it (no
// migration / back-fill — hard reset is acceptable).

import { and, eq, inArray, notInArray } from 'drizzle-orm'

import { immediateWrite } from '../board/contention'
import type { ClawbooDb } from '../db'
import { capabilities, type DbCapability, type DbCapabilityInsert } from '../schema'

export interface ListCapabilitiesFilter {
  sourceId?: string
  /** Restrict to these owning adapters (used to merge stale rows for degraded sources). */
  sourceIds?: string[]
  runtime?: string
  kind?: string
  scope?: string
  agentId?: string
}

/**
 * The mutable columns an upsert overwrites — everything except `id` (the PK) and
 * `created_at` (set once on first insert). Keeping this list explicit means a new
 * column is a conscious add, never a silent clobber.
 */
function updateSet(row: DbCapabilityInsert, now: number): Partial<DbCapabilityInsert> {
  return {
    sourceId: row.sourceId,
    sourceKey: row.sourceKey,
    kind: row.kind,
    runtime: row.runtime,
    scope: row.scope,
    agentId: row.agentId ?? null,
    origin: row.origin,
    manageability: row.manageability,
    name: row.name,
    description: row.description ?? '',
    availability: row.availability ?? null,
    available: row.available ?? 1,
    diagnostics: row.diagnostics ?? '[]',
    provenance: row.provenance ?? null,
    status: row.status ?? 'ready',
    tenantId: row.tenantId ?? null,
    syncedAt: row.syncedAt,
    updatedAt: now,
  }
}

/**
 * Source-scoped reconcile in ONE transaction: delete this source's rows that are
 * no longer present, then upsert the current set (insert-or-update by `id`).
 * Idempotent — a re-read with no change leaves the table byte-identical (apart
 * from `synced_at`/`updated_at`).
 */
export function upsertCapabilities(
  db: ClawbooDb,
  sourceId: string,
  rows: DbCapabilityInsert[],
): void {
  const now = Date.now()
  const ids = rows.map((r) => r.id)
  immediateWrite(db, (tx) => {
    // Reconcile: drop rows this source no longer reports.
    if (ids.length === 0) {
      tx.delete(capabilities).where(eq(capabilities.sourceId, sourceId)).run()
    } else {
      tx.delete(capabilities)
        .where(and(eq(capabilities.sourceId, sourceId), notInArray(capabilities.id, ids)))
        .run()
    }
    for (const r of rows) {
      const row: DbCapabilityInsert = {
        ...r,
        agentId: r.agentId ?? null,
        description: r.description ?? '',
        availability: r.availability ?? null,
        available: r.available ?? 1,
        diagnostics: r.diagnostics ?? '[]',
        provenance: r.provenance ?? null,
        status: r.status ?? 'ready',
        tenantId: r.tenantId ?? null,
        createdAt: now,
        updatedAt: now,
      }
      tx.insert(capabilities)
        .values(row)
        .onConflictDoUpdate({ target: capabilities.id, set: updateSet(r, now) })
        .run()
    }
  })
}

export function listCapabilities(
  db: ClawbooDb,
  filter: ListCapabilitiesFilter = {},
): DbCapability[] {
  const conds = []
  if (filter.sourceId) conds.push(eq(capabilities.sourceId, filter.sourceId))
  if (filter.sourceIds && filter.sourceIds.length > 0) {
    conds.push(inArray(capabilities.sourceId, filter.sourceIds))
  }
  if (filter.runtime) conds.push(eq(capabilities.runtime, filter.runtime))
  if (filter.kind) conds.push(eq(capabilities.kind, filter.kind))
  if (filter.scope) conds.push(eq(capabilities.scope, filter.scope))
  if (filter.agentId) conds.push(eq(capabilities.agentId, filter.agentId))
  const q = db.select().from(capabilities)
  return (conds.length > 0 ? q.where(and(...conds)) : q).all()
}

export function getCapability(db: ClawbooDb, id: string): DbCapability | null {
  return db.select().from(capabilities).where(eq(capabilities.id, id)).get() ?? null
}
