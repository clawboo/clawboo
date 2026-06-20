// The single read path both the Ghost Graph AND the Capabilities dashboard
// consume (via GET /api/capabilities). Fans the multiplexer, PERSISTS each OK
// source's records (source-scoped reconcile → the durable projection), and serves
// the last-good table rows for any DEGRADED source (disconnect tolerance: a
// blipped Gateway never blanks the inventory). Fresh records win on id collision.

import {
  parseCapabilityId,
  type CapabilityRecord,
  type CapabilitySourceId,
  type SourceReadStatus,
} from '@clawboo/capability-registry'
import { createDb, listCapabilities, upsertCapabilities } from '@clawboo/db'

import { getDbPath } from '../db'
import { recordToInsert, rowToRecord } from './mapper'
import { getCapabilityMultiplexer } from './registry'

export interface CapabilityFilter {
  runtime?: string
  kind?: string
  scope?: string
  agentId?: string
}

export interface CapabilityView {
  records: CapabilityRecord[]
  sources: SourceReadStatus[]
}

function matches(r: CapabilityRecord, f: CapabilityFilter): boolean {
  if (f.runtime && r.runtime !== f.runtime) return false
  if (f.kind && r.kind !== f.kind) return false
  if (f.scope && r.scope !== f.scope) return false
  if (f.agentId && r.agentId !== f.agentId) return false
  return true
}

export async function loadCapabilities(filter: CapabilityFilter = {}): Promise<CapabilityView> {
  const { records, sources } = await getCapabilityMultiplexer().read()
  const db = createDb(getDbPath())

  // Persist each OK source (source-scoped reconcile).
  const bySource = new Map<CapabilitySourceId, CapabilityRecord[]>()
  for (const r of records) {
    const sid = parseCapabilityId(r.id)?.sourceId
    if (!sid) continue
    const arr = bySource.get(sid) ?? []
    arr.push(r)
    bySource.set(sid, arr)
  }
  for (const s of sources) {
    if (s.ok) {
      upsertCapabilities(db, s.sourceId, (bySource.get(s.sourceId) ?? []).map(recordToInsert))
    }
  }

  // Serve last-good table rows for degraded sources (disconnect tolerance).
  const degradedIds = sources.filter((s) => !s.ok).map((s) => s.sourceId)
  const stale = degradedIds.length
    ? listCapabilities(db, { sourceIds: degradedIds }).map(rowToRecord)
    : []

  // Fresh-wins dedup by id, then filter.
  const seen = new Set<string>()
  const merged: CapabilityRecord[] = []
  for (const r of [...records, ...stale]) {
    if (seen.has(r.id)) continue
    seen.add(r.id)
    if (matches(r, filter)) merged.push(r)
  }
  return { records: merged, sources }
}
