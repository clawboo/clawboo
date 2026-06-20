// Maps a CapabilityRecord (the wire/domain shape) ↔ a DbCapability row. Kept in
// apps/web (not @clawboo/db) so the db package stays decoupled from
// @clawboo/capability-registry — the agent-registry precedent (domain records map
// to Db* rows in the server, not the db package).

import { parseCapabilityId, type CapabilityRecord } from '@clawboo/capability-registry'
import type { DbCapability, DbCapabilityInsert } from '@clawboo/db'

export function recordToInsert(r: CapabilityRecord): DbCapabilityInsert {
  const now = Date.now()
  return {
    id: r.id,
    sourceId: parseCapabilityId(r.id)?.sourceId ?? 'native',
    sourceKey: r.sourceKey,
    kind: r.kind,
    runtime: r.runtime,
    scope: r.scope,
    agentId: r.agentId,
    origin: r.source,
    manageability: r.manageability,
    name: r.name,
    description: r.description,
    availability: r.availability ? JSON.stringify(r.availability) : null,
    available: r.available ? 1 : 0,
    diagnostics: JSON.stringify(r.diagnostics),
    provenance: r.provenance ? JSON.stringify(r.provenance) : null,
    status: r.status,
    tenantId: r.tenantId,
    syncedAt: Date.parse(r.syncedAt) || now,
    // upsertCapabilities overrides these; included to satisfy the insert type.
    createdAt: now,
    updatedAt: now,
  }
}

function parseJson<T>(value: string | null, fallback: T): T {
  if (!value) return fallback
  try {
    return JSON.parse(value) as T
  } catch {
    return fallback
  }
}

export function rowToRecord(row: DbCapability): CapabilityRecord {
  const source = row.origin as CapabilityRecord['source']
  const manageability = row.manageability as CapabilityRecord['manageability']
  // A runtime-of-record OpenClaw extension (MCP connector / plugin) is NOT
  // writable by clawboo — its config.patch toggle is a follow-up. The live read
  // stamps `writable: false`, but the column doesn't persist it, so DERIVE it here
  // from the row's runtime characteristics. Without this, the degraded last-good
  // DB path (a disconnected OpenClaw source served via listCapabilities) would
  // drop `writable` and the dead Enable/Disable button would resurface. Keeps the
  // UI + REST gate a pure function of the record, never a per-runtime literal.
  const nonWritable = source === 'openclaw-extension' && manageability === 'runtime-of-record'
  return {
    id: row.id,
    sourceKey: row.sourceKey,
    kind: row.kind as CapabilityRecord['kind'],
    runtime: row.runtime,
    scope: row.scope as CapabilityRecord['scope'],
    agentId: row.agentId,
    source,
    manageability,
    name: row.name,
    description: row.description,
    availability: parseJson<CapabilityRecord['availability']>(row.availability, null),
    available: row.available !== 0,
    diagnostics: parseJson<string[]>(row.diagnostics, []),
    provenance: parseJson<CapabilityRecord['provenance']>(row.provenance, null),
    status: row.status as CapabilityRecord['status'],
    ...(nonWritable ? { writable: false } : {}),
    tenantId: row.tenantId,
    syncedAt: new Date(row.syncedAt).toISOString(),
  }
}
